import { describe, expect, it } from "vitest";

import {
  OD_MCP_RESOURCE_TEMPLATES,
  OD_MCP_STATIC_RESOURCES,
  OD_MCP_TOOL_DEFS,
  OD_MCP_TOOL_NAMES,
} from "../src/mcp/od-catalog.js";

describe("Open Design MCP catalog", () => {
  it("declares the complete product tool surface once", () => {
    expect(OD_MCP_TOOL_NAMES).toEqual([
      "list_projects",
      "get_active_context",
      "get_artifact",
      "get_project",
      "get_file",
      "search_files",
      "list_files",
      "create_artifact",
      "write_file",
      "delete_file",
      "delete_project",
      "create_project",
      "list_skills",
      "list_plugins",
      "start_run",
      "get_run",
      "cancel_run",
      "list_agents",
    ]);
    expect(new Set(OD_MCP_TOOL_NAMES).size).toBe(OD_MCP_TOOL_DEFS.length);
  });

  it("publishes the active resource and installed-content templates", () => {
    expect(OD_MCP_STATIC_RESOURCES.map(({ uri }) => uri)).toEqual([
      "od://focus/active",
    ]);
    expect(OD_MCP_RESOURCE_TEMPLATES.map(({ uriTemplate }) => uriTemplate))
      .toEqual([
        "od://skills/{id}/SKILL.md",
        "od://design-systems/{id}/DESIGN.md",
      ]);
  });
});
