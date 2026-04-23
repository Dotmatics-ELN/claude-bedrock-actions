# Specification: `src/index.js`

This document specifies the behavior, contracts, and constraints of the GitHub Action entry script [`src/index.js`](../src/index.js). The packaged runtime entry is `dist/index.js` (built via `@vercel/ncc` per [`package.json`](../package.json)); this specification applies to the **source** module and its compiled output when behavior is preserved one-to-one.

---

## 1. Purpose

The script is a **Node.js GitHub Action** that:

1. Reads **Robot Framework standard output XML** from a caller-configured folder.
2. Identifies **failed test cases** in that XML.
3. For each failure, calls **Amazon Bedrock** (`Converse` API) with a structured prompt to infer a **plain-language root cause**.
4. **Appends** human-readable defect records to a caller-configured markdown file.
5. Exposes a numeric **output** indicating how many failures were processed.

It is designed to run in a GitHub Actions runner with AWS credentials and region available to the AWS SDK.

---

## 2. Runtime, dependencies, and integration surface

### 2.1 Node and packaging

- **Engine**: Node `>=24` (see `package.json` `engines`).
- **Action runner**: `action.yml` declares `using: 'node24'` and `main: 'dist/index.js'`.

### 2.2 External modules

| Module | Role |
|--------|------|
| `fs` | Synchronous filesystem reads, directory walks, append/write of defects and status files. |
| `path` | Path joining, relative paths, extension checks, absolute-path detection. |
| `@actions/core` | Required inputs, logging (`info`, `warning`, `error`), failure signaling, step outputs. |
| `fast-xml-parser` (`XMLParser`) | Parse Robot output XML with attributes preserved. |
| `@aws-sdk/client-bedrock-runtime` | `BedrockRuntimeClient`, `ConverseCommand` for model inference. |

### 2.3 Environment variables

| Variable | Usage |
|----------|--------|
| `GITHUB_WORKSPACE` | If set, used as the **workspace root** for resolving relative paths and gathering repository context. If unset, falls back to `process.cwd()`. |
| `AWS_REGION` | **Required** for Bedrock client construction. If missing, `getBedrockClient()` throws. |
| Standard AWS credential env vars / instance metadata | Implicitly used by `@aws-sdk/client-bedrock-runtime` (not referenced directly in this file). |

### 2.4 GitHub Action inputs and outputs

Aligned with [`action.yml`](../action.yml):

| Input | Required | Semantics |
|-------|----------|-----------|
| `folder` | Yes | Path to a directory containing `*.xml` files (case-insensitive extension). Resolved with `resolvePath` against workspace. Must exist and be a directory. |
| `defects_file` | Yes | Path to the markdown file for output. Resolved with `resolvePath`. Must be non-blank after trim. |

| Output | Semantics |
|--------|-----------|
| `failures_processed` | Stringified integer: `0` when no XML files, no failures, or early exit paths that write a status note; otherwise the count of failed test cases for which an append (or Bedrock failure placeholder) was written. |

---

## 3. Constants

| Name | Value | Meaning |
|------|-------|---------|
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-4-6` | Fixed Bedrock model identifier passed to `ConverseCommand`. |
| `REPO_CONTEXT_MAX_FILES` | `14` | Maximum number of repository files included in the Bedrock prompt context. |
| `REPO_CONTEXT_MAX_BYTES_PER_FILE` | `4096` | Per-file UTF-8 body cap before truncation marker. |
| `REPO_CONTEXT_TOTAL_CAP` | `24000` | Maximum total character length of concatenated context chunks (including markdown wrappers). |
| `XML_SNIPPET_MAX` | `12000` | Maximum length of JSON-serialized failed test XML subtree snippet in the prompt. |

---

## 4. Path resolution

### 4.1 `resolvePath(p, workspace)`

- If `p` is absolute (`path.isAbsolute(p)`), returns `p` unchanged.
- Otherwise returns `path.join(workspace, p)`.

### 4.2 Workspace root

`workspace = process.env.GITHUB_WORKSPACE || process.cwd()`.

All relative `folder` and `defects_file` inputs, repository context gathering, and XML path display use this workspace unless noted.

---

## 5. Pure helpers and XML/Robot semantics

### 5.1 `asArray(value)`

- `null` / `undefined` → `[]`.
- Arrays → unchanged.
- Any other value → single-element array `[value]`.

Used to normalize `fast-xml-parser` nodes that may be singular objects or arrays.

### 5.2 `nodeText(node)`

Extracts human-readable text from heterogeneous XML-derived nodes:

- `null` / `undefined` → `''`.
- `string` / `number` → trimmed string.
- Array → `nodeText` on each element, non-empty parts joined by newline, trimmed.
- Object:
  - If `#text` exists → that value as trimmed string.
  - Else if exactly one non-attribute key → if inner is string, return trimmed inner; otherwise `''`.
- Otherwise → `''`.

### 5.3 `getAttr(node, name)`

- Missing or non-object `node` → `''`.
- Prefers `node['@_' + name]` (fast-xml-parser attribute convention), else `node[name]`, coerced to string.
- Returns `''` if neither is usable.

### 5.4 `collectFailMessagesFromSubtree(node, out)`

Depth-first traversal of an object/array tree:

- For every `msg` child (as array), if `level` attribute is exactly `'FAIL'`, appends trimmed text from `nodeText(m)` to `out` when non-empty.
- Recurses into all keys except `msg` and keys starting with `@_`.

**Note:** This collects FAIL-level messages anywhere under the test node, not only at specific depths.

### 5.5 `getDirectTestStatus(test)`

- Reads `test.status`.
- If missing → `null`.
- If array → returns **last** element (treated as final status).
- Otherwise returns the single status node.

### 5.6 `isFailedStatus(statusNode)`

True iff `getAttr(statusNode, 'status') === 'FAIL'`.

### 5.7 `buildTestCaseName(suitePath, test)`

- `testName` = `getAttr(test, 'name')` or `'Unknown test'`.
- `prefix` = non-empty segments of `suitePath` joined with `' :: '`.
- Returns `prefix + ' :: ' + testName` if prefix non-empty, else `testName`.

### 5.8 `serializeXmlSnippet(obj, maxLen)`

- `JSON.stringify(obj, null, 0)` (minified).
- If length ≤ `maxLen`, return full string.
- Else return first `maxLen` characters plus newline and `…(truncated)`.
- On stringify throw → `''`.

### 5.9 `extractFailuresFromRobotDoc(doc)`

**Input document shape:**

- Treats `doc.robot` if present, else `doc` as `robot` root.
- If falsy `robot`, returns empty `failures` array.

**Suite walk:**

- Starts from `asArray(robot.suite)` with initial `suitePath` `[]`.
- For each suite: optional `name` attribute extends `suitePath`.
- Recurses into nested `suite.suite`.
- For each `suite.test`:
  - `finalStatus = getDirectTestStatus(t)`.
  - Skip if no `finalStatus` or not `isFailedStatus(finalStatus)`.
  - `messages`: from `collectFailMessagesFromSubtree(t, messages)`.
  - If `nodeText(finalStatus)` non-empty, append to messages.
  - `errorMessage` = unique messages (via `[...new Set(messages)]`) joined by newlines, trimmed; if empty fall back to `statusMsg`; if still empty → `'(no message in XML)'`.
  - Push object: `{ testCaseName, errorMessage, xmlContext }` where `xmlContext = serializeXmlSnippet(t, XML_SNIPPET_MAX)`.

**Ordering:** Failures appear in **document order** (suite order, then test order within suites), depth-first.

---

## 6. Filesystem: XML listing

### 6.1 `listXmlFiles(folder)`

- `fs.readdirSync(folder)` (no recursion).
- Filters names whose **lowercase** name ends with `.xml`.
- Returns full paths via `path.join(folder, n)`.

**Non-goals:** Does not validate XML here; does not follow subfolders.

---

## 7. Repository context for prompts

### 7.1 `gatherRepositoryContext(workspace)`

**Goal:** Build a single markdown string of representative repo files to include in the Bedrock prompt.

**Skipped directories** (by **entry name** only, not full path):  
`.git`, `node_modules`, `.cursor`, `dist`, `coverage`, `.github`.

**Included extensions** (lowercase):  
`.robot`, `.resource`, `.py`, `.md`, `.txt`, `.yml`, `.yaml`.

**Walk behavior:**

- Recursive from `workspace`, `depth` starting at `0`.
- Stops recursing deeper than **depth 6** (`depth > 6`).
- Stops if `collected.length >= REPO_CONTEXT_MAX_FILES` or `total >= REPO_CONTEXT_TOTAL_CAP`.
- Directory iteration order is **filesystem / `readdirSync` order** (not sorted).
- Unreadable directories: catch, skip subtree.
- Each file: read as UTF-8; on read error, skip file.
- Truncate body to `REPO_CONTEXT_MAX_BYTES_PER_FILE` with `\n…(truncated)` suffix if longer.
- Each file becomes a chunk:  
  `### File: <relativePath>\n\n\`\`\`\n<body>\n\`\`\`\n\n`  
  where `relativePath = path.relative(workspace, full)`.
- If adding the next chunk would exceed `REPO_CONTEXT_TOTAL_CAP`, **break** (partial add of that chunk is not attempted).

**Return:** `collected.join('')` — may be empty string if no matching files or all skipped.

---

## 8. AWS Bedrock

### 8.1 `getBedrockClient()`

- Reads `process.env.AWS_REGION`.
- If falsy → throws `Error` with message instructing to set `AWS_REGION`.
- Returns `new BedrockRuntimeClient({ region })`.

### 8.2 `inferRootCause({ client, testCaseName, errorMessage, xmlSnippet, repoContext, sourceXmlRelative })`

**Prompt content (conceptual):**

- System-framed as a senior test automation engineer.
- Sections: Failure (test name, source XML path, error text), XML subtree as JSON (or `(none)`), additional repo files (or placeholder).
- Instructs: concise root cause, plain language, under 12 sentences, no verbatim repetition of the whole error.

**API call:**

- `ConverseCommand` with:
  - `modelId: BEDROCK_MODEL_ID`
  - Single user message, single text block.
  - `inferenceConfig`: `maxTokens: 2048`, `temperature: 0.2`.

**Response handling:**

- Reads `response.output.message.content` array.
- Concatenates `b.text` for blocks where `text` is a string; trims.
- If no blocks or empty joined text → returns fixed fallback strings  
  `'(Bedrock returned no text content.)'` or `'(Bedrock returned empty text.)'`.

**Errors:** Not caught inside this function; propagate to caller.

---

## 9. Defect file I/O

### 9.1 `appendDefectMarkdown(defectsPath, { testCaseName, errorMessage, rootCause })`

Appends UTF-8 text block:

- Leading blank line.
- `Test Case Name - <single line: newlines in test name replaced by space>`
- `Error Message - <trimmed errorMessage>`
- `Root Cause - <trimmed rootCause>`
- Trailing blank line.

Uses `fs.appendFileSync`.

### 9.2 `ensureDefectsFile(defectsPath)`

- Creates parent directory recursively if missing.
- If file missing, creates empty file (`''`).

### 9.3 `writeSimpleStatus(defectsPath, message)`

- Ensures parent directory exists (recursive).
- **Overwrites** file with `message.trim()` + single newline.

---

## 10. Main procedure (`main`)

### 10.1 Input acquisition and validation

1. Resolve `workspace` (see §4.2).
2. `folderInput = core.getInput('folder', { required: true }).trim()`.
3. `defectsFileInput = core.getInput('defects_file', { required: true }).trim()`.
4. If `defectsFileInput` is empty → `core.setFailed(...)`, `process.exit(1)`.
5. `folder = resolvePath(folderInput, workspace)`. If not exists or not directory → `core.setFailed`, `process.exit(1)`.
6. `defectsPath = resolvePath(defectsFileInput, workspace)`.

### 10.2 Branch: no XML files

- `xmlFiles = listXmlFiles(folder)`.
- If empty:
  - `core.info` explains no XML found.
  - `writeSimpleStatus(defectsPath, 'No XML files were found.')` — **does not** call `ensureDefectsFile` first; relies on `writeSimpleStatus` to mkdir parent and overwrite file.
  - `core.setOutput('failures_processed', '0')`.
  - Return (no Bedrock).

### 10.3 Parse XML and build failure queue

- Construct `XMLParser` with `ignoreAttributes: false`, `trimValues: true`, `processEntities: false`.
- `failureQueue = []`.
- For each `xmlPath` in `xmlFiles`:
  - Read UTF-8; on error → `core.warning`, skip file.
  - Parse; on error → `core.warning`, skip file.
  - `failures = extractFailuresFromRobotDoc(doc)`.
  - `relXml = path.relative(workspace, xmlPath) || xmlPath`.
  - For each failure `f`, push `{ failure: f, relXml }` onto `failureQueue`.

**Cross-file ordering:** Failures are queued in the order XML files are returned by `readdirSync`, then document order within each file.

### 10.4 Branch: no failures in any XML

- If `failureQueue.length === 0`:
  - `core.info` no failed tests.
  - `writeSimpleStatus(defectsPath, 'No errors were found.')`.
  - `core.setOutput('failures_processed', '0')`.
  - Return.

### 10.5 Process failures (Bedrock + append)

1. `ensureDefectsFile(defectsPath)` — creates empty file if needed (does not truncate existing content).
2. `repoContext = gatherRepositoryContext(workspace)` — **one** snapshot shared for **all** failures in the run.
3. `client = getBedrockClient()` — throws if no region (uncaught here; see §10.6).
4. `failureCount = 0`.
5. For each `{ failure: f, relXml }`:
   - Increment `failureCount`.
   - `core.info` with test name and relative XML path.
   - Try `inferRootCause(...)`; on catch:
     - `core.error` with message.
     - `rootCause` set to `` `(Bedrock call failed: ${e.message})` ``.
   - `appendDefectMarkdown` with `testCaseName`, `errorMessage`, `rootCause`.
6. Final `core.info` with count and defects path.
7. `core.setOutput('failures_processed', String(failureCount))`.

**Important:** `failureCount` counts **attempted** analyses (queue length), including those where Bedrock threw and a placeholder root cause was written.

### 10.6 Top-level error handler

`main().catch((e) => { core.setFailed(e.message || String(e)); process.exit(1); })`.

Typical uncaught failures: missing `AWS_REGION`, unhandled Bedrock auth errors before per-failure try/catch, unexpected runtime errors.

---

## 11. Observable behavior summary

| Condition | Defects file behavior | `failures_processed` |
|-----------|------------------------|----------------------|
| Invalid/missing `folder` | Not written (process exits) | N/A (failed step) |
| Blank `defects_file` after trim | Not written | N/A |
| No `.xml` in folder | Overwritten with status line | `0` |
| XML present, no failed tests | Overwritten with status line | `0` |
| One or more failures | File ensured; **append** blocks per failure | Count of queue items |
| Bedrock error on one failure | That entry gets placeholder root cause; others still processed | Full count |

---

## 12. Assumptions and limitations (non-exhaustive)

- **Robot XML schema:** Logic assumes Robot Framework output structure (`robot` / `suite` / `test` / `status` / `msg` with attributes as produced by typical Rebot/output tooling). Non-Robot XML parses successfully but yields zero failures.
- **Determinism:** Repository context order depends on filesystem iteration; not stable across OS or runs.
- **Concurrency:** Fully synchronous file reads except async Bedrock calls **sequential** in a single loop (no parallelism).
- **Idempotency:** Re-running the action **appends** to an existing defects file when failures exist; it does not clear prior content.
- **Security:** Prompt includes file contents from the workspace; callers must trust what gets embedded and comply with data policies.
- **Model and region:** Hard-coded model ID; changing behavior requires code change.

---

## 13. Change control

When modifying `src/index.js`, update this specification if any of the following change: inputs/outputs, constants, XML failure detection rules, prompt contract, Bedrock invocation parameters, file formats, exit codes, or error messages relied upon by workflows.
