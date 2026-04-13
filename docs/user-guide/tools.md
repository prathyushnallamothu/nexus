# Tools

Nexus has a comprehensive set of tools for file operations, web access, terminal commands, and more. Tools are the building blocks that enable Nexus to take actions.

## Tool Categories

### Files & Code

- **read_file** — Read a file at a specified path
- **write_file** — Write content to a file (creates or overwrites)
- **patch_file** — Apply targeted edits to a file (safer than write_file)
- **search_files** — Search for files matching a pattern

### Terminal & Shell

- **shell** — Execute shell commands (foreground or background)
- **process_status** — Check status of background processes

### Git Operations

- **git_status** — Show git repository status
- **git_diff** — Show git diff
- **git_commit** — Commit changes
- **git_log** — Show git commit history
- **git_branch** — List or create branches

### Web & Network

- **web_search** — Web search using Exa, Tavily, Serper, or DuckDuckGo
- **fetch_url** — Fetch and read any URL
- **http_request** — Full REST API client (GET, POST, PUT, PATCH, DELETE)
- **download_file** — Download files from URLs
- **check_url** — Check URL reachability

### Browser Automation

- **screenshot_url** — Screenshot a webpage
- **scrape_page** — Scrape rendered page content (including JS SPAs)
- **browser_click** — Click elements on a webpage
- **browser_fill** — Fill forms on a webpage
- **browser_eval** — Evaluate JavaScript on a webpage

### Vision & Images

- **analyze_image** — Analyze images (OCR, object detection, etc.)
- **read_text_from_image** — Extract text from images/screenshots
- **generate_image** — Generate images from text prompts

### Data

- **read_csv** — Read CSV files with filtering and pagination
- **read_json** — Read and query JSON files
- **write_json** — Write JSON files
- **query_sqlite** — Execute SQL queries against SQLite databases
- **read_pdf** — Extract text from PDF files
- **read_xml** — Parse XML files

### System

- **notify** — Send desktop notifications
- **clipboard_read** — Read system clipboard
- **clipboard_write** — Write to system clipboard
- **system_info** — Get system information (OS, CPU, memory, disk)
- **open_url** — Open URLs in default browser
- **zip** — Compress files to ZIP archives
- **unzip** — Extract ZIP archives
- **get_env** — Read environment variables safely

### Wiki & Memory

- **wiki_read** — Read a wiki page
- **wiki_write** — Write/update a wiki page
- **wiki_log** — Append to chronological log
- **wiki_search** — Search across wiki content
- **wiki_list** — List pages by category
- **wiki_lint** — Health-check the wiki
- **wiki_ingest** — Ingest external documents
- **wiki_save_session** — Archive session transcripts
- **wiki_recall** — FTS5 full-text search (primary memory retrieval)
- **wiki_similar** — Find related pages
- **wiki_observe** — Record user observations

### MCP & Scheduling

- **mcp_add_server** — Add an MCP server configuration
- **mcp_list_servers** — List configured MCP servers
- **mcp_test_server** — Test an MCP server connection
- **mcp_list_tools** — List tools from MCP servers
- **cron_create** — Create a scheduled task
- **cron_list** — List scheduled tasks
- **cron_delete** — Delete a scheduled task
- **cron_toggle** — Enable/disable a scheduled task

### Planning

- **task_plan** — Create a task plan
- **task_update** — Update a task
- **task_list** — List tasks
- **task_complete** — Mark a task as complete
- **task_checkpoint** — Create a task checkpoint

## Tool Usage Rules

Nexus follows these rules when using tools:

1. **Prefer patch_file over write_file** — Safer and more precise for edits
2. **Use git_* tools for git operations** — Not shell commands
3. **Always use web_search for internet lookups** — Not shell+curl
4. **Use scrape_page for JavaScript-rendered pages** — Not fetch_url
5. **Use http_request for REST APIs with auth** — Not shell+curl
6. **Use run_code to safely test code** — Not shell execution
7. **Use analyze_image when given an image** — Automatic detection

## Tool Permissions

Nexus has a permission system that controls tool access:

- **Path-based permissions** — Control which paths can be accessed
- **Tool-level permissions** — Enable/disable specific tools
- **Approval required** — Require user approval for dangerous operations

Configure permissions in `.nexus/governance/permissions.json`:

```json
{
  "allowedPaths": [
    "/path/to/project",
    "/path/to/allowed/directory"
  ],
  "deniedPaths": [
    "/etc",
    "/system"
  ],
  "toolPermissions": {
    "shell": {
      "allowed": true,
      "approvalRequired": true
    },
    "write_file": {
      "allowed": true,
      "approvalRequired": false
    }
  }
}
```

## MCP Tools

Connect to external tools via the Model Context Protocol (MCP). MCP servers provide additional tools that Nexus can use.

### Adding MCP Servers

Edit `.nexus/mcp.json`:

```json
{
  "github": {
    "name": "GitHub",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
    },
    "enabled": true
  }
}
```

### Using MCP Tools

Once configured, MCP tools are automatically available to Nexus. Use `/tools` to see all available tools including MCP tools.

## Tool Monitoring

Nexus monitors tool usage:

- **Usage tracking** — How often each tool is used
- **Cost tracking** — Token usage and costs per tool
- **Failure tracking** — Success/failure rates
- **Repetition detection** — Detects repeated tool calls

View tool stats:

```
❯ /stats
```

## Best Practices

1. **Let Nexus choose tools** — Don't specify which tools to use. Let Nexus decide based on the task.
2. **Use patch_file for edits** — Safer than write_file for targeted changes.
3. **Review tool calls** — Check what tools Nexus is using, especially for dangerous operations.
4. **Configure permissions** — Set up permissions to restrict access to sensitive paths.
5. **Monitor costs** — Track token usage and costs per tool.

## Next Steps

- [Skills System](./skills.md) — How Nexus learns from tasks
- [Modes](./modes.md) — Create specialized agents
- [Memory System](./memory.md) — Persistent knowledge base
- [Middleware](./middleware.md) — Composable middleware pipeline
