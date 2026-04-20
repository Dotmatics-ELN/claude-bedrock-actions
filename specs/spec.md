# Specification: AI Test Engineering Services Defect Analysis

## Requirements Overview

Implement a Custom Javascript Github Action that takes as input a set of Robot Framework standard output xml files and extracts and analyses any failures contained in the XML using AWS Bedrock. Each set of output xml files will relate to a specific named workflow run which will be passed into the Action as a parameter. Each failure should be appended to a named markdown file, the name of which will be passed into the Action as a parameter.

## Input parameters for the Github Action:

folder -> The name of a folder containing xml files in standard Robot Framework format.
defects_file -> The filename of a markdown file used to log failure information.

## Input parameters validation

Check that folder input parameter is a valid folder
Check that defects_file input parameter is non-blank

## Processing of Robot Framework XML Files

Create the file referenced by defects_file in the input parameters if it does not already exist.
Each XML file in the input folder must be processed to find any errors contained therein.
If no XML files can be found in the folder referenced by input parameter folder then create the file referenced by defects_file with simple message to indicate that no XML files were found.

For each error found, append data pertaining to the error to the file referenced by defects_file in the input parameters using the generalised format detailed in the 'Defect Format' section of this document.

For each error found, use AWS Bedrock to try to determine the cause of the error and add this to the information for the error. Use any resources found in the repository including XML output files and other .robot and .resource files as input to this process.

If no errors were found in any of the present XML files then still create the file referenced by defects_file with simple message to indicate that no errors were found.

## Defect Format

The overall file format should be Markdown.

Test Case Name - extracted from XML around found error.
Error Message - extracted from XML around found error.
Root Cause - the determined root cause from AWS Bedrock.

## Technical Details

The base node version for the code should be 24
When analysing failures, the AWS Bedrock model 'us.anthropic.claude-sonnet-4-6' must be used.
AWS authentication with AWS standard variables will be handled outside of this custom Github Action.