const fs = require('fs');
const path = require('path');
const core = require('@actions/core');
const { XMLParser } = require('fast-xml-parser');
const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const BEDROCK_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
const REPO_CONTEXT_MAX_FILES = 14;
const REPO_CONTEXT_MAX_BYTES_PER_FILE = 4096;
const REPO_CONTEXT_TOTAL_CAP = 24000;
const XML_SNIPPET_MAX = 12000;
const INCOGNITO_VARIABLE_MARKER = '${incognito}';

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function nodeText(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (Array.isArray(node)) return node.map(nodeText).filter(Boolean).join('\n').trim();
  if (typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, '#text')) {
      return String(node['#text']).trim();
    }
    const nonAttr = Object.keys(node).filter((k) => !k.startsWith('@_'));
    if (nonAttr.length === 1) {
      const inner = node[nonAttr[0]];
      if (typeof inner === 'string') return inner.trim();
    }
  }
  return '';
}

function getAttr(node, name) {
  if (!node || typeof node !== 'object') return '';
  const prefixed = node[`@_${name}`];
  if (prefixed !== undefined && prefixed !== null) return String(prefixed);
  if (node[name] !== undefined && node[name] !== null) return String(node[name]);
  return '';
}

function collectFailMessagesFromSubtree(node, out) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectFailMessagesFromSubtree(item, out);
    return;
  }
  if (typeof node !== 'object') return;

  const msg = node.msg;
  for (const m of asArray(msg)) {
    const level = getAttr(m, 'level');
    if (level === 'FAIL') {
      const t = nodeText(m);
      if (t) out.push(t);
    }
  }

  for (const [key, val] of Object.entries(node)) {
    if (key === 'msg' || key.startsWith('@_')) continue;
    collectFailMessagesFromSubtree(val, out);
  }
}

function getDirectTestStatus(test) {
  const st = test.status;
  if (st == null) return null;
  return Array.isArray(st) ? st[st.length - 1] : st;
}

function isFailedStatus(statusNode) {
  return getAttr(statusNode, 'status') === 'FAIL';
}

function buildTestCaseName(suitePath, test) {
  const testName = getAttr(test, 'name') || 'Unknown test';
  const prefix = suitePath.filter(Boolean).join(' :: ');
  return prefix ? `${prefix} :: ${testName}` : testName;
}

function isIncognitoRelatedFailure({ testCaseName, errorMessage, xmlContext }) {
  const haystack = [testCaseName, errorMessage, xmlContext].join('\n');
  return haystack.includes(INCOGNITO_VARIABLE_MARKER);
}

function serializeXmlSnippet(obj, maxLen) {
  try {
    const s = JSON.stringify(obj, null, 0);
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen)}\n…(truncated)`;
  } catch {
    return '';
  }
}

function extractFailuresFromRobotDoc(doc) {
  const failures = [];
  const robot = doc.robot || doc;
  if (!robot) return failures;

  function walkSuite(suite, suitePath) {
    if (!suite) return;
    const name = getAttr(suite, 'name');
    const nextPath = name ? [...suitePath, name] : [...suitePath];

    for (const s of asArray(suite.suite)) walkSuite(s, nextPath);
    for (const t of asArray(suite.test)) {
      const finalStatus = getDirectTestStatus(t);
      if (!finalStatus || !isFailedStatus(finalStatus)) continue;

      const messages = [];
      collectFailMessagesFromSubtree(t, messages);
      const statusMsg = nodeText(finalStatus);
      if (statusMsg) messages.push(statusMsg);
      const errorMessage = [...new Set(messages)].join('\n').trim() || statusMsg || '(no message in XML)';

      failures.push({
        testCaseName: buildTestCaseName(nextPath, t),
        errorMessage,
        xmlContext: serializeXmlSnippet(t, XML_SNIPPET_MAX),
      });
    }
  }

  for (const s of asArray(robot.suite)) walkSuite(s, []);
  return failures;
}

function listXmlFiles(folder) {
  const names = fs.readdirSync(folder);
  return names
    .filter((n) => n.toLowerCase().endsWith('.xml'))
    .map((n) => path.join(folder, n));
}

function gatherRepositoryContext(workspace) {
  const skipDirs = new Set([
    '.git',
    'node_modules',
    '.cursor',
    'dist',
    'coverage',
    '.github',
  ]);
  const wantExt = new Set(['.robot', '.resource', '.py', '.md', '.txt', '.yml', '.yaml']);

  const collected = [];
  let total = 0;

  function walk(dir, depth) {
    if (depth > 6 || collected.length >= REPO_CONTEXT_MAX_FILES || total >= REPO_CONTEXT_TOTAL_CAP) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (collected.length >= REPO_CONTEXT_MAX_FILES || total >= REPO_CONTEXT_TOTAL_CAP) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      if (!wantExt.has(ext)) continue;
      let body;
      try {
        body = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (body.length > REPO_CONTEXT_MAX_BYTES_PER_FILE) {
        body = `${body.slice(0, REPO_CONTEXT_MAX_BYTES_PER_FILE)}\n…(truncated)`;
      }
      const rel = path.relative(workspace, full);
      const chunk = `### File: ${rel}\n\n\`\`\`\n${body}\n\`\`\`\n\n`;
      if (total + chunk.length > REPO_CONTEXT_TOTAL_CAP) break;
      collected.push(chunk);
      total += chunk.length;
    }
  }

  walk(workspace, 0);
  return collected.join('');
}

function getBedrockClient() {
  const region = process.env.AWS_REGION;
  if (!region) {
    throw new Error(
      'AWS region is not set. Provide AWS_REGION in the environment.',
    );
  }
  return new BedrockRuntimeClient({ region });
}

async function inferRootCause({
  client,
  testCaseName,
  errorMessage,
  xmlSnippet,
  repoContext,
  sourceXmlRelative,
}) {
  const prompt = `Analyze this failed Robot Framework test and state the root cause briefly.

Test: ${testCaseName}
Source: ${sourceXmlRelative}
Error:
${errorMessage}

XML (truncated JSON):
${xmlSnippet || '(none)'}

Repository context (may be incomplete):
${repoContext || '(none)'}

Reply in 1–3 short sentences. State the likely root cause only—no preamble, headings, bullet lists, or repetition of the error text.`;

  const response = await client.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }],
        },
      ],
      inferenceConfig: {
        maxTokens: 256,
        temperature: 0.2,
      },
    }),
  );

  const blocks = response?.output?.message?.content;
  if (!blocks || !blocks.length) {
    return '(Bedrock returned no text content.)';
  }
  const texts = blocks
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean);
  return texts.join('\n').trim() || '(Bedrock returned empty text.)';
}

function appendDefectMarkdown(defectsPath, { testCaseName, errorMessage, rootCause }) {
  const block = [
    '',
    `Test Case Name - ${testCaseName.replace(/\r?\n/g, ' ')}`,
    `Error Message - ${errorMessage.trim()}`,
    `Root Cause - ${rootCause.trim()}`,
    '',
  ]
    .join('\n');
  fs.appendFileSync(defectsPath, block, 'utf8');
}

function resolvePath(p, workspace) {
  if (path.isAbsolute(p)) return p;
  return path.join(workspace, p);
}

function ensureDefectsFile(defectsPath) {
  const defectsDir = path.dirname(defectsPath);
  if (!fs.existsSync(defectsDir)) {
    fs.mkdirSync(defectsDir, { recursive: true });
  }
  if (!fs.existsSync(defectsPath)) {
    fs.writeFileSync(defectsPath, '', 'utf8');
  }
}

function writeSimpleStatus(defectsPath, message) {
  const defectsDir = path.dirname(defectsPath);
  if (!fs.existsSync(defectsDir)) {
    fs.mkdirSync(defectsDir, { recursive: true });
  }
  fs.writeFileSync(defectsPath, `${message.trim()}\n`, 'utf8');
}

async function main() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const folderInput = core.getInput('folder', { required: true }).trim();
  const defectsFileInput = core.getInput('defects_file', { required: true }).trim();

  if (!defectsFileInput) {
    core.setFailed('Input "defects_file" must be non-blank.');
    process.exit(1);
  }

  const folder = resolvePath(folderInput, workspace);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    core.setFailed(`Input "folder" must be a valid directory. Not found or not a directory: ${folder}`);
    process.exit(1);
  }

  const defectsPath = resolvePath(defectsFileInput, workspace);
  const xmlFiles = listXmlFiles(folder);
  if (xmlFiles.length === 0) {
    core.info(`No XML files found in folder "${folder}". Writing status note to defects file.`);
    writeSimpleStatus(defectsPath, 'No XML files were found.');
    core.setOutput('failures_processed', '0');
    return;
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
    processEntities: false,
  });

  const failureQueue = [];
  for (const xmlPath of xmlFiles) {
    let xml;
    try {
      xml = fs.readFileSync(xmlPath, 'utf8');
    } catch (e) {
      core.warning(`Skipping unreadable file ${xmlPath}: ${e.message}`);
      continue;
    }
    let doc;
    try {
      doc = parser.parse(xml);
    } catch (e) {
      core.warning(`Skipping invalid XML ${xmlPath}: ${e.message}`);
      continue;
    }

    const failures = extractFailuresFromRobotDoc(doc);
    const relXml = path.relative(workspace, xmlPath) || xmlPath;
    for (const f of failures) {
      if (isIncognitoRelatedFailure(f)) {
        core.info(`Ignoring failure associated with ${INCOGNITO_VARIABLE_MARKER}: ${f.testCaseName} (${relXml})`);
        continue;
      }
      failureQueue.push({ failure: f, relXml });
    }
  }

  if (failureQueue.length === 0) {
    core.info('No failed test cases found in XML. Writing status note to defects file.');
    writeSimpleStatus(defectsPath, 'No errors were found.');
    core.setOutput('failures_processed', '0');
    return;
  }

  ensureDefectsFile(defectsPath);
  const repoContext = gatherRepositoryContext(workspace);
  const client = getBedrockClient();

  let failureCount = 0;
  for (const { failure: f, relXml } of failureQueue) {
    failureCount += 1;
    core.info(`Analyzing failure: ${f.testCaseName} (${relXml})`);
    let rootCause;
    try {
      rootCause = await inferRootCause({
        client,
        testCaseName: f.testCaseName,
        errorMessage: f.errorMessage,
        xmlSnippet: f.xmlContext,
        repoContext,
        sourceXmlRelative: relXml,
      });
    } catch (e) {
      core.error(`Bedrock analysis failed for "${f.testCaseName}": ${e.message}`);
      rootCause = `(Bedrock call failed: ${e.message})`;
    }
    appendDefectMarkdown(defectsPath, {
      testCaseName: f.testCaseName,
      errorMessage: f.errorMessage,
      rootCause,
    });
  }

  core.info(`Done. Failures processed: ${failureCount}. Defects file: ${defectsPath}`);
  core.setOutput('failures_processed', String(failureCount));
}

main().catch((e) => {
  core.setFailed(e.message || String(e));
  process.exit(1);
});
