import { describe, it, expect } from "bun:test";
import { DynamicSupervisor, PermissionGuard } from "../packages/governance/src/index.js";

describe("Governance Layer: Security and Compliance", () => {
  it("should evaluate dynamic supervision rules properly (HITL)", async () => {
    let hitlTriggered = false;
    
    // Simulate CLI behavior where it asks human
    const supervisor = new DynamicSupervisor({
      rules: [
        {
          toolPattern: /^shell$/,
          argPattern: /npm\s+publish/i,
          level: "hitl",
          reason: "Destructive system command"
        }
      ]
    });
    
    const decision = supervisor.evaluate({
      id: "tool-call-1",
      name: "shell",
      arguments: { command: "npm publish" }
    });
    
    expect(decision.level).toBe("hitl");
  });
  
  it("should enforce the prompt firewall / path guard", () => {
    // Tests for permission paths
    const guard = new PermissionGuard("/the/workspace");
    
    expect(guard.check("/the/workspace/src/app.ts").allowed).toBe(true);
    // Should block path traversal escapes
    expect(guard.check("/etc/passwd").allowed).toBe(false);
    expect(guard.check("/the/workspace/../secrets.env").allowed).toBe(false);
    expect(guard.check("/the/workspace/.ssh/id_rsa").allowed).toBe(false);
  });
});
