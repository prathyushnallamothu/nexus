// Supervisor — dynamic risk-based oversight
export {
  DynamicSupervisor,
  supervisionMiddleware,
  type SupervisionDecision,
  type SupervisionLevel,
  type SupervisionRule,
} from "./supervisor.js";

// Audit — immutable event log with SQLite search
export {
  AuditLogger,
  AuditDB,
  type AuditEntry,
  type AuditSeverity,
  type AuditSearchOpts,
  type AuditStats,
} from "./audit.js";

// Budget — multi-scope with atomic reservations and history
export {
  BudgetStore,
  BudgetHistory,
  BudgetDashboard,
  multiScopeBudgetMiddleware,
  type BudgetConfig,
  type BudgetRecord,
  type BudgetScope,
  type BudgetPeriod,
  type BudgetCheckResult,
  type BudgetReservation,
  type BudgetHistoryEntry,
  type BudgetAggregated,
  type BudgetSummary,
  type MultiScopeBudgetOptions,
} from "./budget.js";

// Permissions — path + tool-level access control
export {
  PermissionGuard,
  permissionMiddleware,
  type PermissionPolicy,
} from "./permissions.js";

// Firewall — prompt injection detection + output redaction
export {
  PromptFirewall,
  firewallMiddleware,
  type InjectionPattern,
  type LeakagePattern,
  type FirewallResult,
} from "./firewall.js";

// Behavioral Monitor — real-time anomaly detection
export {
  BehavioralMonitor,
  monitorMiddleware,
  type AnomalyAlert,
  type MonitorConfig,
} from "./monitor.js";

// Policy — config file with presets, dry-run, and rollback
export {
  PolicyEngine,
  PolicyStore,
  POLICY_PRESETS,
  type NexusPolicy,
  type PolicyPreset,
  type PolicyAction,
  type PolicyDecision,
} from "./policy.js";

// Approval Queue — persistent HITL with CLI/Slack/GitHub channels
export {
  ApprovalQueue,
  createInteractiveSupervisor,
  type ApprovalRequest,
  type ApprovalResult,
  type ApprovalStatus,
  type ApprovalChannel,
} from "./approval.js";

// Network Guard — domain allow/deny + SSRF protection
export {
  NetworkGuard,
  networkMiddleware,
  type NetworkPolicy,
  type NetworkCheckResult,
} from "./network.js";

// Identity — multi-user model with roles and budget overrides
export {
  IdentityManager,
  resolveCurrentIdentity,
  type Identity,
  type IdentityRole,
} from "./identity.js";
