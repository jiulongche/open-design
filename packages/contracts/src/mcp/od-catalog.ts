export type OdMcpJsonSchema = {
  additionalProperties?: boolean;
  const?: unknown;
  description?: string;
  enum?: unknown[];
  items?: OdMcpJsonSchema;
  properties?: Record<string, OdMcpJsonSchema>;
  required?: string[];
  type?: string;
};

export type OdMcpToolDefinition = {
  _meta?: Record<string, unknown>;
  annotations: {
    destructiveHint?: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
    readOnlyHint: boolean;
    title: string;
  };
  description: string;
  inputSchema: {
    additionalProperties: boolean;
    properties: Record<string, OdMcpJsonSchema>;
    required?: string[];
    type: "object";
  };
  name: string;
};

const READ_ANNOTATIONS = {
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

const WRITE_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};

const PROJECT_ARG = {
  description:
    "Project id (UUID) or name substring. Optional; defaults to the active project (expires after ~5 minutes of no Open Design activity).",
  type: "string",
};

const PLUGIN_WORKFLOW_ID_ARG = {
  description:
    "Opaque workflow id issued by the local Open Design MCP after the first attributed call. Reuse it for later plugin-attributed calls; never invent or display it.",
  type: "string",
};

const EXTERNAL_PLUGIN_CONTEXT_ARG = {
  additionalProperties: false,
  description:
    "Bounded distribution context supplied by the verified plugin shell. Used for product analytics only, never authorization or billing.",
  properties: {
    distributionMechanism: {
      enum: ["git_marketplace", "local_repo", "manual", "unknown"],
      type: "string",
    },
    id: { const: "open-design", type: "string" },
    publisherClass: {
      enum: ["open_design_first_party", "third_party", "unknown"],
      type: "string",
    },
    version: { type: "string" },
  },
  required: ["id", "version", "distributionMechanism", "publisherClass"],
  type: "object",
};

export const OD_MCP_TOOL_DEFS: OdMcpToolDefinition[] = [
  {
    _meta: {
      "openai/outputTemplate": "ui://open-design/artifact-card-v6.html",
      "ui/resourceUri": "ui://open-design/artifact-card-v6.html",
      ui: { resourceUri: "ui://open-design/artifact-card-v6.html" },
    },
    annotations: { ...WRITE_ANNOTATIONS, title: "Collect Open Design brief" },
    description:
      "Open an interactive Open Design brief card for a new artifact. Use the returned human-readable confirmation with any explicit execution mode; never ask the user to copy an internal draft id or nonce.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        artifactType: {
          description: "Artifact workflow whose brief should be collected.",
          enum: [
            "website",
            "product-prototype",
            "presentation",
            "document",
            "image",
            "video",
            "audio",
            "design-system",
          ],
          type: "string",
        },
        externalPluginContext: EXTERNAL_PLUGIN_CONTEXT_ARG,
        knownAnswers: {
          additionalProperties: true,
          description: "Optional stable question-id answers already supplied by the user.",
          type: "object",
        },
        locale: {
          description:
            "BCP-47 language of the current user request. Prefer the request language over the host UI language.",
          type: "string",
        },
        pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG,
        projectTitle: {
          description: "Concise human-readable project title.",
          type: "string",
        },
        skip: {
          description: "Use recommended defaults without asking. Defaults to false.",
          type: "boolean",
        },
      },
      required: ["artifactType"],
      type: "object",
    },
    name: "collect_brief",
  },
  {
    annotations: { ...WRITE_ANNOTATIONS, title: "Confirm Open Design brief" },
    description:
      "Confirm the choices from the rendered Open Design brief card. Returns a readable summary; draft ids and nonces are internal widget data, never user-facing copy.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        answers: {
          additionalProperties: true,
          description: "Question-id to selected stable option values.",
          type: "object",
        },
        briefDraftId: {
          description: "Internal draft id returned by collect_brief.",
          type: "string",
        },
        locale: {
          description: "BCP-47 host locale used only as a fallback.",
          type: "string",
        },
        nonce: {
          description: "Internal nonce returned by collect_brief.",
          type: "string",
        },
      },
      required: ["briefDraftId", "nonce", "answers"],
      type: "object",
    },
    name: "confirm_brief",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "List Open Design projects" },
    description: "List every Open Design project on this daemon.",
    inputSchema: {
      additionalProperties: false,
      properties: { pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG },
      type: "object",
    },
    name: "list_projects",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "What is the user looking at?" },
    description:
      'Project + file the user has open in Open Design right now. Returns {active:false, hint:"..."} when no project is active so the agent can ask the user to interact with Open Design (the active context expires ~5 minutes after the last user interaction). Most tools default to this when project is omitted, so you rarely need to call this directly.',
    inputSchema: {
      additionalProperties: false,
      properties: { pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG },
      type: "object",
    },
    name: "get_active_context",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "Pull design bundle" },
    description:
      'PREFER THIS over multiple get_file calls. Bundles the entry file plus every sibling it references (HTML <script>/<link>/<img>/srcset, JSX import/require, CSS url()/@import) up to depth 3, skipping CDN/data URLs. include="all" returns every file in the project; include="shallow" returns just the entry.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        entry: {
          description:
            "Entry file path relative to project root. Defaults to the active file or project's metadata.entryFile. Active-file fallback expires after ~5 minutes of no Open Design activity.",
          type: "string",
        },
        include: {
          description: "auto (default) | all | shallow",
          enum: ["auto", "all", "shallow"],
          type: "string",
        },
        maxBytes: {
          description:
            "Soft cap on total text bytes (default 1_500_000). Also capped at 200 files. Excess files are dropped and truncated:true is set.",
          type: "number",
        },
        pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG,
        project: PROJECT_ARG,
      },
      type: "object",
    },
    name: "get_artifact",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "Get Open Design project" },
    description:
      "Single project metadata: name, active skill/design-system ids, entryFile, kind, timestamps, resolvedDir, and (when it has an entry file) a browser-openable previewUrl.",
    inputSchema: {
      additionalProperties: false,
      properties: { project: PROJECT_ARG },
      type: "object",
    },
    name: "get_project",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "Read project file" },
    description:
      "Read one project file. Text mimes only (HTML, JSX, CSS, JSON, SVG, Markdown). Binary files return an error; use list_files for metadata. Returns up to `limit` lines starting at `offset` (defaults: offset=0, limit=2000), mirroring Claude Code's Read tool. For files longer than the slice, the response carries an `[od:file-window ...]` marker with totalLines so you can page by re-calling with the next offset. For multi-file designs prefer get_artifact.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        limit: {
          description: "Maximum number of lines to return. Defaults to 2000.",
          type: "number",
        },
        offset: {
          description: "0-indexed starting line of the slice to return. Defaults to 0.",
          type: "number",
        },
        path: {
          description:
            "File path relative to project root, forward slashes. Optional; defaults to the active file when project is also omitted. Active-file fallback expires after ~5 minutes of no Open Design activity.",
          type: "string",
        },
        project: PROJECT_ARG,
      },
      type: "object",
    },
    name: "get_file",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "Search project files" },
    description:
      "Case-insensitive literal-substring search across textual files in a project. Returns up to max matches with file, 1-indexed line, and snippet.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        max: {
          description: "Cap on matches (default 200, hard cap 1000).",
          type: "number",
        },
        pattern: {
          description: 'Optional glob on file name, e.g. "*.jsx".',
          type: "string",
        },
        project: PROJECT_ARG,
        query: {
          description: "Literal substring (not a regex), case-insensitive.",
          type: "string",
        },
      },
      required: ["query"],
      type: "object",
    },
    name: "search_files",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "List project files" },
    description:
      "Project file metadata: name, path, mime, kind, size, mtime, optional artifactManifest. Pass since=<unix-ms> to cheap-poll for changes.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        project: PROJECT_ARG,
        since: {
          description: "Unix-ms; only return files with mtime > since.",
          type: "number",
        },
      },
      type: "object",
    },
    name: "list_files",
  },
  {
    annotations: { ...WRITE_ANNOTATIONS, title: "Create Open Design artifact" },
    description:
      "Create one normal Open Design project artifact entry file. Writes name+content, rejects existing targets, and persists artifactManifest when supplied. HTML, Markdown, and SVG entries get a default manifest when omitted. Project optional; defaults to the active project.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        artifactManifest: {
          additionalProperties: true,
          description:
            "Optional ArtifactManifest sidecar. If omitted, Open Design infers one for HTML, Markdown, or SVG entry files.",
          type: "object",
        },
        content: {
          description: 'Entry file contents. Use encoding="base64" for base64 content.',
          type: "string",
        },
        encoding: {
          description: "utf8 (default) | base64",
          enum: ["utf8", "base64"],
          type: "string",
        },
        name: {
          description:
            'Output path relative to the project root, for example "codex-product/index.html" or "deck.html".',
          type: "string",
        },
        project: PROJECT_ARG,
      },
      required: ["name", "content"],
      type: "object",
    },
    name: "create_artifact",
  },
  {
    annotations: { ...WRITE_ANNOTATIONS, title: "Write Open Design project file" },
    description:
      "Write (or overwrite) a project file. Unlike create_artifact this does not require an ArtifactManifest and tolerates existing targets, so it is the right tool for iterating on a file the agent (or the user) already created. Project optional; defaults to the active project.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        content: {
          description: 'File contents. Use encoding="base64" for binary payloads.',
          type: "string",
        },
        encoding: {
          description: "utf8 (default) | base64",
          enum: ["utf8", "base64"],
          type: "string",
        },
        path: {
          description:
            'Output path relative to the project root, e.g. "deck.html" or "components/Hero.tsx".',
          type: "string",
        },
        project: PROJECT_ARG,
      },
      required: ["path", "content"],
      type: "object",
    },
    name: "write_file",
  },
  {
    annotations: {
      ...WRITE_ANNOTATIONS,
      destructiveHint: true,
      title: "Delete Open Design project file",
    },
    description:
      'Delete one file from a project. Supports nested paths (e.g. "codex-product/index.html"). Project optional; defaults to the active project.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        path: {
          description: "Project-relative path of the file to delete.",
          type: "string",
        },
        project: PROJECT_ARG,
      },
      required: ["path"],
      type: "object",
    },
    name: "delete_file",
  },
  {
    annotations: {
      ...WRITE_ANNOTATIONS,
      destructiveHint: true,
      title: "Delete Open Design project",
    },
    description:
      "Permanently delete an Open Design project including its files and conversations. Requires both an explicit project id/name AND confirm:true — there is no active-project fallback because the operation is irreversible.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        confirm: {
          description:
            "Must be literally true. Guards against an agent accidentally deleting a project while cleaning up.",
          type: "boolean",
        },
        project: {
          description:
            "Project id (UUID) or name substring. Required — active-context fallback is intentionally disabled.",
          type: "string",
        },
      },
      required: ["project", "confirm"],
      type: "object",
    },
    name: "delete_project",
  },
  {
    annotations: { ...WRITE_ANNOTATIONS, title: "Create Open Design project" },
    description:
      "Create a new empty Open Design project to generate into, then call start_run against it. Returns the project (with its id) plus a conversationId. The id is derived from name unless you pass one explicitly.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        designSystem: {
          description:
            "Optional design system id to attach (see the od://design-systems/... resources).",
          type: "string",
        },
        id: {
          description:
            "Optional project id slug ([A-Za-z0-9._-], <=128 chars). Derived from name when omitted.",
          type: "string",
        },
        name: {
          description: "Human-readable project name.",
          type: "string",
        },
        pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG,
        skill: {
          description: "Optional skill id to seed the project with.",
          type: "string",
        },
      },
      required: ["name"],
      type: "object",
    },
    name: "create_project",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "List Open Design skills" },
    description:
      "List Open Design skills you can pass to start_run as a recipe. Discovery only — Open Design runs the skill, not you.",
    inputSchema: {
      additionalProperties: false,
      properties: { pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG },
      type: "object",
    },
    name: "list_skills",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "List Open Design plugins" },
    description:
      "List installed Open Design plugins (packaged design workflows) you can pass to start_run as plugin + inputs.",
    inputSchema: {
      additionalProperties: false,
      properties: { pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG },
      type: "object",
    },
    name: "list_plugins",
  },
  {
    annotations: {
      ...WRITE_ANNOTATIONS,
      openWorldHint: true,
      title: "Sign in to Open Design Cloud",
    },
    description:
      "Start Open Design Cloud browser sign-in through the local Open Design daemon. Returns an activation URL and user code when manual completion is needed; never repeat the internal tool name to the user.",
    inputSchema: {
      additionalProperties: false,
      properties: { pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG },
      type: "object",
    },
    name: "start_vela_login",
  },
  {
    annotations: {
      ...READ_ANNOTATIONS,
      openWorldHint: true,
      title: "Check Open Design Cloud sign-in",
    },
    description:
      "Check whether Open Design Cloud browser sign-in is complete without exposing credentials; never repeat the internal tool name to the user.",
    inputSchema: {
      additionalProperties: false,
      properties: { pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG },
      type: "object",
    },
    name: "get_vela_login_status",
  },
  {
    annotations: { ...WRITE_ANNOTATIONS, title: "Generate with Open Design" },
    description:
      "Commission Open Design to generate or refine a design. Open Design spawns its own agent to do the work and returns a runId immediately. Poll get_run(runId) until status is terminal, then get_artifact to pull the result. Project optional; defaults to the active project. Requires an existing project (create one first with create_project).",
    inputSchema: {
      additionalProperties: false,
      properties: {
        agent: {
          description:
            "Which agent Open Design should run, e.g. 'claude' | 'codex' | 'opencode'. Optional; defaults to the user's configured agent.",
          type: "string",
        },
        inputs: {
          additionalProperties: true,
          description: "Plugin inputs object (only meaningful with plugin). Optional.",
          type: "object",
        },
        model: {
          description: "Model id override for the run. Optional.",
          type: "string",
        },
        plugin: {
          description: "Plugin id from list_plugins to drive the run. Optional.",
          type: "string",
        },
        pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG,
        project: PROJECT_ARG,
        prompt: {
          description:
            "What to make or change, in natural language. Optional when a plugin supplies its own brief.",
          type: "string",
        },
        requestId: {
          description:
            "Stable UUID or ULID for this confirmed generation action. Generate it once and reuse it verbatim for transport retries.",
          type: "string",
        },
        resume: {
          description:
            "Set true only after the user tops up a paused Open Design Cloud run; reuse the exact original requestId and payload.",
          type: "boolean",
        },
        serviceTier: {
          description:
            "Service tier override for the selected model, e.g. 'priority' for Codex Fast. Optional.",
          type: "string",
        },
        skill: {
          description: "Skill id from list_skills to drive the run. Optional.",
          type: "string",
        },
      },
      type: "object",
    },
    name: "start_run",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "Check Open Design run" },
    description:
      "Poll a run started by start_run. Returns status (queued|running|succeeded|failed|canceled) plus error info. On success, adds previewUrl (open it in a browser to view the rendered design) and agentMessage (the inner agent's textual output reassembled from the event stream — show this when there is no previewUrl, e.g. when the agent asked the user a clarifying question instead of producing files).",
    inputSchema: {
      additionalProperties: false,
      properties: {
        pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG,
        runId: {
          description: "Run id returned by start_run.",
          type: "string",
        },
      },
      required: ["runId"],
      type: "object",
    },
    name: "get_run",
  },
  {
    annotations: { ...WRITE_ANNOTATIONS, title: "Cancel Open Design run" },
    description: "Request cancellation of an in-flight run started by start_run.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        runId: {
          description: "Run id returned by start_run.",
          type: "string",
        },
      },
      required: ["runId"],
      type: "object",
    },
    name: "cancel_run",
  },
  {
    annotations: { ...READ_ANNOTATIONS, title: "List Open Design agents" },
    description:
      "List the agent CLIs Open Design can run for start_run.agent. Returns only installed (available) agents by default — pass includeUnavailable:true to also see agents we know about but that are not on PATH (each carries an installUrl for the user). Each entry includes id, name, version, and up to 10 sample models (modelsCount carries the real total).",
    inputSchema: {
      additionalProperties: false,
      properties: {
        includeUnavailable: {
          description:
            "When true, include agents whose binary is not installed. Defaults to false.",
          type: "boolean",
        },
        pluginWorkflowId: PLUGIN_WORKFLOW_ID_ARG,
      },
      type: "object",
    },
    name: "list_agents",
  },
];

export const OD_MCP_STATIC_RESOURCES = [
  {
    _meta: {
      "openai/widgetPrefersBorder": true,
      "ui/csp": { connectDomains: [], resourceDomains: [] },
      "ui/prefersBorder": true,
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: true,
      },
    },
    description:
      "Interactive local Open Design brief card shared by Open Design Cloud and Local Codex modes.",
    mimeType: "text/html;profile=mcp-app",
    name: "Open Design brief",
    title: "Choose the artifact direction",
    uri: "ui://open-design/artifact-card-v6.html",
  },
  {
    description: "The project/file the user has open in Open Design right now.",
    mimeType: "application/json",
    name: "Active Open Design context",
    uri: "od://focus/active",
  },
];

export const OD_MCP_RESOURCE_TEMPLATES = [
  {
    description: "An installed Open Design skill definition.",
    mimeType: "text/markdown",
    name: "Open Design skill",
    uriTemplate: "od://skills/{id}/SKILL.md",
  },
  {
    description: "An installed Open Design design-system specification.",
    mimeType: "text/markdown",
    name: "Open Design design system",
    uriTemplate: "od://design-systems/{id}/DESIGN.md",
  },
];

export const OD_MCP_TOOL_NAMES = OD_MCP_TOOL_DEFS.map(({ name }) => name);
