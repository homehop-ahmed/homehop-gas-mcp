# \# homehop-gas-mcp

# 

# Remote MCP server that gives Claude direct read/write/execute access to \*\*Google Apps Script projects\*\* AND \*\*Google Sheets\*\* via the official Google APIs. Bypasses the `script.google.com` block in Claude in Chrome and the lack of Sheets-write in claude.ai's default connectors.

# 

# After this is deployed and connected to claude.ai, Claude can:

# 

# \*\*Apps Script (7 tools):\*\*

# \- Read the current content of any Apps Script project you own

# \- Replace one file or the whole project (push code from chat → live in the editor instantly)

# \- Create versioned snapshots

# \- Look up the bound script for a Sheets / Docs / Slides file

# \- \*\*Execute a function inside a project (`gas\_run\_function`) — runs server-side and returns the function's return value. No more "click Run in the editor."\*\*

# 

# \*\*Google Sheets (9 tools):\*\*

# \- Get metadata (title, tabs, row/col counts)

# \- Read any range or whole tab

# \- Append rows to the bottom of a tab

# \- Update specific ranges (in-place edits)

# \- Clear ranges (preserve formatting)

# \- Create new tabs

# \- Delete tabs

# \- Apply HomeHop header formatting (bold white on `#1F3864`, freeze row 1)

# 

# \## Architecture in 30 seconds

# 

# \[claude.ai chat] ──HTTPS──► \[this server on Railway] ──Google API──► \[Apps Script + Sheets]

# &#x20;                                      │

# &#x20;                                      └─ uses YOUR Google refresh\_token (single-user mode)

# 

# Single-user setup: you authorize once locally (with `npm run setup`), the server then uses your stored `refresh\_token` for every API call.

# 

# \## What changed in v0.3.0

# 

# Added `gas\_run\_function` — calls Apps Script API's `scripts.run` endpoint to execute a function server-side and return its result to Claude. Removes the need for a human to click "Run" in the Apps Script editor for autonomous workflows.

# 

# \*\*Important one-time GCP setup required\*\* to use the new tool:

# 1\. \*\*Enable the Apps Script API\*\* in the GCP project hosting this MCP server.

# 2\. \*\*Link your Apps Script project to that same GCP project\*\*: open the script editor → Project Settings → "Change project" → enter the GCP project number.

# 3\. The OAuth scopes in `src/setup.js` already include `script.scriptapp`, so existing refresh tokens minted from this repo should work without re-authorization.

# 

# \## What changed in v0.2.0

# 

# Added 9 Sheets tools alongside the existing 6 Apps Script tools.

# 

# \## Tools exposed

# 

# | Tool | What it does |

# |---|---|

# | `gas\_get\_content` | Read all files in a project |

# | `gas\_update\_content` | Replace the entire file set in a project |

# | `gas\_patch\_file` | Replace one named file, write back |

# | `gas\_get\_project\_metadata` | Title, createTime, parentId, etc. |

# | `gas\_find\_bound\_script` | Given a Sheets file ID, find its bound script |

# | `gas\_create\_version` | Snapshot a versioned release |

# | `gas\_run\_function` | \*\*NEW in v0.3.0\*\* — execute a function via scripts.run |

# | `sheets\_get\_metadata` | Title + tabs with row/col counts |

# | `sheets\_list\_tabs` | Just the array of tab names |

# | `sheets\_read\_range` | Read a range in A1 notation |

# | `sheets\_append\_rows` | Append rows to the bottom of a tab |

# | `sheets\_update\_range` | Overwrite cells in a specific range |

# | `sheets\_clear\_range` | Clear values |

# | `sheets\_create\_tab` | Add a new tab |

# | `sheets\_delete\_tab` | Delete a tab |

# | `sheets\_format\_header` | Apply HomeHop header style |

# 

# \## Troubleshooting

# 

# \- \*\*`/healthz` returns 502\*\* → check Railway logs. Usually an env var is missing.

# \- \*\*Claude says "tool not available"\*\* → toggle the connector off and on in the chat composer.

# \- \*\*`gas\_run\_function` returns "Apps Script API has not been used"\*\* → enable Apps Script API in your GCP project.

# \- \*\*`gas\_run\_function` returns PERMISSION\_DENIED\*\* → script isn't linked to the same GCP project. Project Settings → Change project.

# \- \*\*`gas\_run\_function` returns 401 / invalid\_scope\*\* → refresh token was minted before `script.scriptapp` was in the scope list. Re-run `npm run setup`.

