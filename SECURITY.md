# Security Policy

## Supported versions

Only the latest `2.x` release is actively supported.

## Reporting a vulnerability

If you find a security vulnerability in video-watcher, please **do not open a public issue**.

Instead, report it privately via [GitHub Security Advisories](https://github.com/GopkoDev/video-watcher/security/advisories/new).

Include:
- A description of the vulnerability
- Steps to reproduce
- The affected version
- Any suggested fix if you have one

I aim to respond within 7 days and issue a fix within 30 days for confirmed vulnerabilities.

## Scope

In scope:
- The MCP server code (`mcp-server/`)
- The plugin manifest and configuration
- The slash commands and skill

Out of scope:
- Issues in upstream dependencies (report to their maintainers)
- Issues specific to Claude Code itself

## Sensitive data

This plugin handles:
- Video files provided by the user
- Frames extracted from them
- Transcribed audio content

None of it is logged or transmitted anywhere. Processing happens inside the plugin's own
Node process — ffmpeg as WebAssembly, whisper through transformers.js — and the only
outbound request the plugin makes is the one-time download of public whisper model weights
from HuggingFace. The plugin uses no API keys.

Frames and transcripts are of course returned to Claude Code, since that is what lets Claude
answer questions about the video; they are subject to your Claude Code data handling
settings.
