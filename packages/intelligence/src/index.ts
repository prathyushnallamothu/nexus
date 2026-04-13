// Skills — procedural memory with approval workflow
export {
  SkillStore,
  type Skill,
  type SkillChange,
  type SkillMatch,
  type SkillExport,
} from "./skills.js";

// Router — dual-process routing with explanations
export {
  DualProcessRouter,
  System1Executor,
  type RouterConfig,
  type RoutingDecision,
} from "./router.js";

// Trajectories — types and outcome classification
export {
  classifyOutcome,
  type Trajectory,
  type Reflection,
  type OutcomeClassification,
} from "./trajectories.js";

// Learner — full learning loop with DB persistence
export {
  ExperienceLearner,
  type LearnerConfig,
  type LearnResult,
} from "./learner.js";

// Database — SQLite-backed persistence
export {
  LearningDB,
  type StoredTrajectory,
  type SkillMetrics,
  type ApprovalRecord,
  type EvalResult,
  type SkillChangelogEntry,
  type Benchmark,
  type BenchmarkRun,
  type OutcomeType,
  type SkillStatus,
  type EvalType,
} from "./db.js";

// Evaluator + Benchmark Suite
export { SkillEvaluator, BenchmarkSuite } from "./eval.js";

// Modes — domain-specific behavior injection
export { ModeManager, type Mode } from "./modes.js";

// Memory — semantic + episodic
export {
  MemoryManager,
  type SemanticFact,
  type EpisodicRecord,
  type MemorySearchResult,
} from "./memory.js";

// Skills I/O — SKILL.md marketplace & GitHub installer
export {
  parseSkillMd,
  skillMdToNexus,
  nexusToSkillMd,
  installFromFile,
  GitHubSkillInstaller,
  SkillsDirScanner,
  SkillsShClient,
  type ParsedSkillMd,
  type SkillMdFrontmatter,
  type InstallResult,
  type RegistrySkill,
} from "./skills-io.js";
