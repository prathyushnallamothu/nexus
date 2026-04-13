import { describe, it, expect } from "bun:test";
import { SkillStore, DualProcessRouter } from "../packages/intelligence/src/index.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("Intelligence Layer: System 1 / System 2 Router", () => {
  it("should route to system2 if no skills match", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nexus-test-"));
    const skillStore = new SkillStore(tmp);
    const router = new DualProcessRouter(skillStore);
    
    // An unknown task should go to system2
    const decision = router.route("Analyze the quantum entangled state of the database");
    expect(decision.path).toBe("system2");
    expect(decision.skillMatch).toBeUndefined();
  });

  it("should route to system1 if a skill matches with high confidence", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nexus-test-"));
    const skillStore = new SkillStore(tmp);
    
    // Seed a skill directly
    const mockSkill = {
      id: "test-skill-1",
      name: "Write Unit Test",
      description: "Generates tests for code.",
      procedure: "1. Read file 2. Write tests",
      version: 1,
      triggers: ["write tests", "generate test", "unit test"],
      tags: ["testing"],
      successRate: 0.95,
      usageCount: 10,
      avgCostUsd: 0.05
    };
    
    // Inject the mock skill into the store's private skills map for testing
    (skillStore as any).skills.set(mockSkill.id, mockSkill);
    
    const router = new DualProcessRouter(skillStore);
    
    // The query explicitly matches a trigger "unit test"
    const decision = router.route("I want to run a unit test for my code.");
    expect(decision.path).toBe("system1");
    expect(decision.skillMatch).toBeDefined();
    expect(decision.skillMatch!.skill.name).toBe("Write Unit Test");
    
    // Check if the cost saving was tracked
    const stats = router.getStats();
    expect(stats.system1).toBeGreaterThan(0);
    expect(stats.costSaved).toBeGreaterThan(0.01);
  });
});
