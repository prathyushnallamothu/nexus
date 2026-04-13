import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import {
  Activity,
  TerminalSquare,
  BrainCircuit,
  ShieldAlert,
  Settings,
  MessageSquare,
  Zap,
  TrendingDown,
  X,
  Send,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Clock,
  DollarSign,
  Cpu,
  Hash,
} from 'lucide-react';
// @ts-ignore - CSS import
import './index.css';

const API = 'http://localhost:8080';

// ── Helpers ───────────────────────────────────────────────

async function fetchAPI(path: string, opts?: RequestInit) {
  try {
    const r = await fetch(`${API}${path}`, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } catch (e: any) {
    return null;
  }
}

function timeAgo(ts: number | string): string {
  const ms = typeof ts === 'string' ? new Date(ts).getTime() : ts;
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Components ────────────────────────────────────────────

const Sidebar = () => {
  const location = useLocation();
  const navs = [
    { path: '/', icon: Activity, label: 'Dashboard' },
    { path: '/skills', icon: BrainCircuit, label: 'Learned Skills' },
    { path: '/audit', icon: ShieldAlert, label: 'Audit Logs' },
    { path: '/sessions', icon: Hash, label: 'Sessions' },
    { path: '/terminal', icon: TerminalSquare, label: 'Terminal' },
    { path: '/settings', icon: Settings, label: 'Settings' },
  ];

  return (
    <nav className="glass-panel sidebar">
      <div className="sidebar-logo">
        <Zap size={28} color="var(--accent-color)" />
        NEXUS
      </div>
      <div className="nav-links">
        {navs.map((nav) => {
          const Icon = nav.icon;
          const isActive = location.pathname === nav.path;
          return (
            <Link key={nav.path} to={nav.path} className={`nav-item ${isActive ? 'active' : ''}`}>
              <Icon size={20} />
              {nav.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
};

const Header = ({ title, subtitle }: { title: string; subtitle?: string }) => (
  <header className="glass-panel header">
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>{title}</h2>
      {subtitle && <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{subtitle}</span>}
    </div>
    <div className="pulse-indicator">
      <div className="pulse-dot"></div>
      Nexus Core Online
    </div>
  </header>
);

const ChatWidget = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: 'system', content: 'Connected to API surface (thread: web-dashboard)' }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMsg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;
    const currMsg = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: currMsg }]);
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: currMsg, threadId: 'web-dashboard' })
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'agent', content: data.response || '(no response)' }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'system', content: `Error: ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`glass-panel chat-widget ${isOpen ? '' : 'closed'}`}>
      <div className="chat-header" onClick={() => setIsOpen(!isOpen)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <MessageSquare size={18} color="var(--accent-color)" />
          <span style={{ fontWeight: 500 }}>Chat with Nexus</span>
        </div>
        {isOpen ? <X size={18} /> : null}
      </div>
      {isOpen && (
        <>
          <div className="chat-messages">
            {messages.map((m, i) => (
              <div key={i} className={`message ${m.role}`}>{m.content}</div>
            ))}
            {loading && <div className="message agent" style={{ opacity: 0.6 }}>Thinking…</div>}
            <div ref={messagesEndRef} />
          </div>
          <form className="chat-input" onSubmit={sendMsg}>
            <input
              placeholder="Ask Nexus anything…"
              value={input}
              onChange={e => setInput(e.target.value)}
              disabled={loading}
            />
            <button type="submit" disabled={loading}><Send size={18} /></button>
          </form>
        </>
      )}
    </div>
  );
};

// ── Pages ─────────────────────────────────────────────────

const Dashboard = () => {
  const [metrics, setMetrics] = useState<any>(null);
  const [skills, setSkills] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);

  useEffect(() => {
    fetchAPI('/api/metrics').then(d => d && setMetrics(d));
    fetchAPI('/api/skills').then(d => d?.skills && setSkills(d.skills.slice(0, 3)));
    fetchAPI('/api/audit?limit=5').then(d => d?.entries && setAudit(d.entries));
  }, []);

  const s1Pct = metrics
    ? Math.round((metrics.system1Routes / Math.max(1, metrics.system1Routes + metrics.system2Routes)) * 100)
    : 0;

  return (
    <div className="content-area">
      <div className="stats-grid">
        <div className="glass-panel stat-card">
          <span className="stat-title"><Cpu size={16} /> LLM Calls</span>
          <span className="stat-value">{metrics?.totalLlmCalls ?? '–'}</span>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Total across all sessions</span>
        </div>
        <div className="glass-panel stat-card" style={{ '--accent-color': '#4ade80' } as any}>
          <span className="stat-title"><TrendingDown size={16} /> System 1 Routing</span>
          <span className="stat-value">{s1Pct}%</span>
          <span style={{ color: '#4ade80', fontSize: '0.85rem' }}>
            ${metrics?.totalCostUsd?.toFixed(4) ?? '0.0000'} total cost
          </span>
        </div>
        <div className="glass-panel stat-card" style={{ '--accent-color': '#ff2a70' } as any}>
          <span className="stat-title"><ShieldAlert size={16} /> Audit Entries</span>
          <span className="stat-value">{metrics?.auditEntries ?? '–'}</span>
          <span style={{ color: '#ff2a70', fontSize: '0.85rem' }}>Immutable event trail</span>
        </div>
        <div className="glass-panel stat-card" style={{ '--accent-color': '#a78bfa' } as any}>
          <span className="stat-title"><BrainCircuit size={16} /> Skills Learned</span>
          <span className="stat-value">{metrics?.skillsCount ?? '–'}</span>
          <span style={{ color: '#a78bfa', fontSize: '0.85rem' }}>Procedural memory</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        <div className="glass-panel" style={{ padding: '2rem' }}>
          <h3 className="section-title"><ShieldAlert size={20} color="var(--accent-color)" /> Recent Audit Events</h3>
          <div className="activity-feed">
            {audit.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No audit events yet. Start a session.</p>
            )}
            {audit.map((entry, i) => (
              <div key={i} className="feed-item">
                <div className="feed-icon">
                  {entry.severity === 'critical' || entry.severity === 'blocked'
                    ? <AlertTriangle size={20} color="#ff2a70" />
                    : entry.severity === 'warning'
                    ? <AlertTriangle size={20} color="#fbbf24" />
                    : <CheckCircle2 size={20} />}
                </div>
                <div className="feed-content">
                  <h4>{entry.action}</h4>
                  <p>{entry.category} · {entry.severity}</p>
                </div>
                <div style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  {timeAgo(entry.timestamp)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-panel" style={{ padding: '2rem' }}>
          <h3 className="section-title"><BrainCircuit size={20} color="var(--accent-color)" /> Top Skills</h3>
          <div className="activity-feed">
            {skills.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No skills learned yet. Complete a few tasks first.</p>
            )}
            {skills.map((skill, i) => (
              <div key={i} className="feed-item">
                <div className="feed-content" style={{ flex: 1 }}>
                  <h4>{skill.name}</h4>
                  <p>{skill.description?.slice(0, 80)}…</p>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ color: '#4ade80', fontWeight: 500 }}>
                    {(skill.successRate * 100).toFixed(0)}%
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                    {skill.usageCount} uses
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const SkillsPage = () => {
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    fetchAPI('/api/skills').then(d => {
      setSkills(d?.skills ?? []);
      setLoading(false);
    });
  }, []);

  return (
    <div className="content-area">
      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: '1.5rem' }}>
        <div className="glass-panel" style={{ padding: '2rem' }}>
          <h3 className="section-title"><BrainCircuit size={20} color="var(--accent-color)" /> Learned Skills ({skills.length})</h3>
          {loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
          {!loading && skills.length === 0 && (
            <p style={{ color: 'var(--text-muted)' }}>No skills yet. The Experience Learner creates skills automatically after complex tasks.</p>
          )}
          <div className="activity-feed">
            {skills.map((skill, i) => (
              <div
                key={i}
                className="feed-item"
                style={{ cursor: 'pointer', background: selected?.id === skill.id ? 'rgba(69,243,255,0.05)' : undefined }}
                onClick={() => setSelected(selected?.id === skill.id ? null : skill)}
              >
                <div className="feed-content" style={{ flex: 1 }}>
                  <h4>{skill.name} <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>v{skill.version}</span></h4>
                  <p>{skill.category} · {skill.tags?.join(', ')}</p>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ color: skill.successRate >= 0.8 ? '#4ade80' : '#fbbf24', fontWeight: 500 }}>
                    {(skill.successRate * 100).toFixed(0)}%
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{skill.usageCount}x</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {selected && (
          <div className="glass-panel" style={{ padding: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>{selected.name}</h3>
              <button
                onClick={() => setSelected(null)}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
              ><X size={18} /></button>
            </div>
            <div style={{ color: 'var(--text-muted)', marginBottom: '1rem', fontSize: '0.9rem' }}>
              {selected.description}
            </div>
            <div style={{ marginBottom: '1rem', display: 'flex', gap: '1rem', fontSize: '0.85rem' }}>
              <span><DollarSign size={14} style={{ display: 'inline' }} /> ${selected.avgCostUsd?.toFixed(4) ?? '0'} avg</span>
              <span><Clock size={14} style={{ display: 'inline' }} /> {selected.avgDurationMs ?? 0}ms avg</span>
              <span><CheckCircle2 size={14} style={{ display: 'inline' }} /> {selected.usageCount} uses</span>
            </div>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--accent-color)' }}>
              Procedure
            </div>
            <pre style={{
              background: 'rgba(0,0,0,0.3)',
              padding: '1rem',
              borderRadius: '8px',
              fontSize: '0.8rem',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              color: '#c9d1d9',
              border: '1px solid var(--border-color)',
            }}>
              {selected.procedure}
            </pre>
            {selected.triggers?.length > 0 && (
              <div style={{ marginTop: '1rem' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--accent-color)' }}>Triggers</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {selected.triggers.map((t: string, i: number) => (
                    <span key={i} style={{
                      background: 'rgba(69,243,255,0.1)',
                      border: '1px solid rgba(69,243,255,0.2)',
                      borderRadius: '20px',
                      padding: '0.2rem 0.75rem',
                      fontSize: '0.8rem',
                      color: 'var(--accent-color)',
                    }}>{t}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const AuditPage = () => {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetchAPI('/api/audit?limit=50').then(d => {
      setEntries(d?.entries ?? []);
      setLoading(false);
    });
  };

  useEffect(() => { load(); }, []);

  const severityColor: Record<string, string> = {
    info: '#4ade80',
    warning: '#fbbf24',
    critical: '#ff2a70',
    blocked: '#ef4444',
  };

  return (
    <div className="content-area">
      <div className="glass-panel" style={{ padding: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h3 className="section-title" style={{ margin: 0 }}>
            <ShieldAlert size={20} color="var(--accent-color)" /> Audit Log (last 50)
          </h3>
          <button
            onClick={load}
            style={{ background: 'rgba(69,243,255,0.1)', border: '1px solid var(--accent-color)', color: 'var(--accent-color)', borderRadius: '8px', padding: '0.5rem 1rem', cursor: 'pointer', display: 'flex', gap: '0.5rem', alignItems: 'center' }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
        {!loading && entries.length === 0 && (
          <p style={{ color: 'var(--text-muted)' }}>No audit entries yet. Start a session to generate events.</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {entries.map((e, i) => (
            <div key={i} style={{
              padding: '0.75rem 1rem',
              borderRadius: '8px',
              background: 'rgba(0,0,0,0.2)',
              border: `1px solid rgba(${e.severity === 'blocked' || e.severity === 'critical' ? '255,42,112' : '255,255,255'},0.06)`,
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              fontSize: '0.85rem',
            }}>
              <span style={{
                padding: '0.2rem 0.6rem',
                borderRadius: '12px',
                fontSize: '0.75rem',
                fontWeight: 600,
                background: `rgba(${e.severity === 'blocked' ? '239,68,68' : e.severity === 'critical' ? '255,42,112' : e.severity === 'warning' ? '251,191,36' : '74,222,128'},0.15)`,
                color: severityColor[e.severity] ?? '#4ade80',
                flexShrink: 0,
                minWidth: '60px',
                textAlign: 'center',
              }}>
                {e.severity}
              </span>
              <span style={{ color: 'var(--accent-color)', flexShrink: 0, minWidth: '80px' }}>{e.category}</span>
              <span style={{ fontWeight: 500, flex: 1 }}>{e.action}</span>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{timeAgo(e.timestamp)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const SessionsPage = () => {
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAPI('/api/sessions').then(d => {
      setSessions(d?.sessions ?? []);
      setLoading(false);
    });
  }, []);

  const statusColor: Record<string, string> = {
    active: '#4ade80',
    completed: 'var(--text-muted)',
    abandoned: '#ff2a70',
  };

  return (
    <div className="content-area">
      <div className="glass-panel" style={{ padding: '2rem' }}>
        <h3 className="section-title"><Hash size={20} color="var(--accent-color)" /> Sessions</h3>
        {loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
        {!loading && sessions.length === 0 && (
          <p style={{ color: 'var(--text-muted)' }}>No sessions recorded yet.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {sessions.map((s, i) => (
            <div key={i} className="glass-panel" style={{ padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>
                  {s.surface} <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>· {s.id?.slice(0, 8)}</span>
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  {s.model ?? 'unknown model'} · {s.messages?.length ?? 0} messages
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: statusColor[s.status] ?? 'var(--text-muted)', fontWeight: 600, marginBottom: '0.25rem' }}>
                  {s.status}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  ${s.budget?.spentUsd?.toFixed(4) ?? '0.0000'} spent
                </div>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', flexShrink: 0 }}>
                {timeAgo(s.createdAt)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const TerminalPage = () => {
  const [lines, setLines] = useState<{ type: string; text: string }[]>([
    { type: 'system', text: '# Nexus Execution Log' },
    { type: 'system', text: 'Connect to the API server at localhost:8080 to stream live events.' },
  ]);
  const [cmd, setCmd] = useState('');
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [lines]);

  const runCmd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cmd.trim() || loading) return;
    const c = cmd;
    setCmd('');
    setLines(prev => [...prev, { type: 'input', text: `$ ${c}` }]);
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: c, threadId: 'terminal' }),
      });
      const data = await res.json();
      const response = data.response || '(no response)';
      response.split('\n').forEach((line: string) => {
        setLines(prev => [...prev, { type: 'output', text: line }]);
      });
    } catch (err: any) {
      setLines(prev => [...prev, { type: 'error', text: `Error: ${err.message}` }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="content-area" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="glass-panel" style={{ flex: 1, padding: '1.5rem', display: 'flex', flexDirection: 'column', fontFamily: 'monospace' }}>
        <div style={{ flex: 1, overflowY: 'auto', marginBottom: '1rem' }}>
          {lines.map((l, i) => (
            <div key={i} style={{
              color: l.type === 'error' ? '#ff2a70' : l.type === 'input' ? 'var(--accent-color)' : l.type === 'system' ? 'var(--text-muted)' : '#f0f0f0',
              fontSize: '0.9rem',
              lineHeight: '1.6',
              whiteSpace: 'pre-wrap',
            }}>{l.text}</div>
          ))}
          {loading && <div style={{ color: 'var(--accent-color)', fontSize: '0.9rem' }}>▋</div>}
          <div ref={endRef} />
        </div>
        <form onSubmit={runCmd} style={{ display: 'flex', gap: '0.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
          <span style={{ color: 'var(--accent-color)', fontFamily: 'monospace', fontSize: '0.9rem', paddingTop: '0.75rem' }}>$</span>
          <input
            style={{ flex: 1, background: 'transparent', border: 'none', color: '#f0f0f0', fontFamily: 'monospace', fontSize: '0.9rem', padding: '0.75rem 0', outline: 'none' }}
            placeholder="Enter a command or ask anything…"
            value={cmd}
            onChange={e => setCmd(e.target.value)}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !cmd.trim()} style={{ background: 'rgba(69,243,255,0.1)', border: '1px solid var(--accent-color)', color: 'var(--accent-color)', borderRadius: '6px', padding: '0.5rem 1rem', cursor: 'pointer' }}>
            Run
          </button>
        </form>
      </div>
    </div>
  );
};

const SettingsPage = () => {
  const [config, setConfig] = useState<any>(null);

  useEffect(() => {
    fetchAPI('/api/config').then(d => d && setConfig(d));
  }, []);

  return (
    <div className="content-area">
      <div className="glass-panel" style={{ padding: '2rem', maxWidth: '640px' }}>
        <h3 className="section-title"><Settings size={20} color="var(--accent-color)" /> Configuration</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {[
            { label: 'Model', key: 'model', hint: 'Set NEXUS_MODEL in .env' },
            { label: 'Budget (USD/session)', key: 'budgetUsd', hint: 'Set NEXUS_BUDGET in .env' },
            { label: 'Nexus Home', key: 'nexusHome', hint: 'Directory for skills, audit logs' },
            { label: 'Skills', key: 'skillsCount', hint: 'Total learned skills' },
            { label: 'Sandbox Mode', key: 'sandboxMode', hint: 'docker = isolated, local = direct' },
          ].map(({ label, key, hint }) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', borderBottom: '1px solid var(--border-color)' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{label}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{hint}</div>
              </div>
              <div style={{ color: 'var(--accent-color)', fontFamily: 'monospace', fontSize: '0.9rem' }}>
                {config?.[key] ?? '–'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ── App Shell ─────────────────────────────────────────────

const pageHeaders: Record<string, { title: string; subtitle: string }> = {
  '/': { title: 'System Overview', subtitle: 'Agent is monitoring all surfaces' },
  '/skills': { title: 'Learned Skills', subtitle: 'Procedural memory from the Experience Learner' },
  '/audit': { title: 'Audit Log', subtitle: 'Immutable trail of every agent action' },
  '/sessions': { title: 'Sessions', subtitle: 'Conversation history across all surfaces' },
  '/terminal': { title: 'Terminal', subtitle: 'Direct CLI interface to the agent' },
  '/settings': { title: 'Settings', subtitle: 'Runtime configuration and environment' },
};

const Layout = () => {
  const location = useLocation();
  const { title, subtitle } = pageHeaders[location.pathname] ?? { title: 'Nexus', subtitle: '' };

  return (
    <div className="layout-container">
      <Sidebar />
      <div className="main-content">
        <Header title={title} subtitle={subtitle} />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/terminal" element={<TerminalPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Page not found</div>} />
        </Routes>
      </div>
      <ChatWidget />
    </div>
  );
};

export default function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  );
}
