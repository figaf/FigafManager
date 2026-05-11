/* global React */
// Shared components for Figaf Installer

// ───────────── SVG icon primitives ─────────────
const Ico = {
  Check: (p) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 8.5l3.2 3.2L13 5" />
    </svg>
  ),
  X: (p) => (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...p}>
      <path d="M2 2l12 12M14 2L2 14" />
    </svg>
  ),
  Min: (p) => (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.2" {...p}>
      <path d="M2 8h12" />
    </svg>
  ),
  Max: (p) => (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.2" {...p}>
      <rect x="2.5" y="2.5" width="11" height="11" />
    </svg>
  ),
  Chev: (p) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  ),
  ChevDown: (p) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  ),
  ArrowRight: (p) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  ),
  ArrowLeft: (p) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M13 8H3M7 4l-4 4 4 4" />
    </svg>
  ),
  External: (p) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M9 3h4v4M13 3L7 9M11 9v3.5a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5v-7a.5.5 0 01.5-.5H7" />
    </svg>
  ),
  Spinner: (p) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" className="spin" {...p}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="8 18" opacity="0.95" />
    </svg>
  ),
  Dot: (p) => (
    <svg viewBox="0 0 16 16" width="8" height="8" {...p}>
      <circle cx="8" cy="8" r="3" fill="currentColor" />
    </svg>
  ),
  Copy: (p) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="5" y="5" width="8" height="8" rx="1.5" />
      <path d="M3 11V3.5A.5.5 0 013.5 3H11" />
    </svg>
  ),
  Trash: (p) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 4.5h10M6 4.5V3a.5.5 0 01.5-.5h3a.5.5 0 01.5.5v1.5M4.5 4.5v8a.5.5 0 00.5.5h6a.5.5 0 00.5-.5v-8" />
    </svg>
  ),
  Terminal: (p) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M5 6.5L7 8l-2 1.5M8.5 10H11" />
    </svg>
  ),
  Info: (p) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v3.5M8 5.5v.01" />
    </svg>
  ),
  Cloud: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M7 18a5 5 0 01-.7-9.95A6 6 0 0118 9a4 4 0 010 8H7z" />
    </svg>
  ),
  Link: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1" />
      <path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" />
    </svg>
  ),
  Shield: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
    </svg>
  ),
  Box: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </svg>
  ),
  Database: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14a8 3 0 0016 0V5M4 12a8 3 0 0016 0" />
    </svg>
  ),
  User: (p) => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0116 0" />
    </svg>
  ),
  Search: (p) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3 3" />
    </svg>
  ),
};

// ───────────── Figaf logo mark ─────────────
function FigafMark({ size = 18 }) {
  return (
    <img 
      src="./figaf-logo.png"
      height={size}
      style={{ objectFit: "contain", borderRadius: 4 }}
      alt="Figaf Logo"
    />
  );
}

// ───────────── Windows 11 chrome ─────────────
function WinFrame({ title = "Figaf Manager", children }) {
  const features = window.figafModeFlags.features;
  const api = typeof window !== "undefined" ? window.figaf : null;

  if (!features.windowChrome) {
    return (
      <div className="win">
        <div className="win-titlebar" style={{ cursor: "default" }}>
          <div className="win-title">
            <FigafMark size={14} />
            <span>{title}</span>
          </div>
        </div>
        <div className="win-body">{children}</div>
      </div>
    );
  }

  const drag = { WebkitAppRegion: "drag" };
  const noDrag = { WebkitAppRegion: "no-drag" };
  return (
    <div className="win">
      <div className="win-titlebar" style={drag}>
        <div className="win-title">
          <FigafMark size={14} />
          <span>{title}</span>
        </div>
        <div className="win-controls" style={noDrag}>
          <div className="win-ctrl" onClick={() => api?.window.minimize()}><Ico.Min/></div>
          <div className="win-ctrl" onClick={() => api?.window.toggleMax()}><Ico.Max/></div>
          <div className="win-ctrl close" onClick={() => api?.window.close()}><Ico.X/></div>
        </div>
      </div>
      <div className="win-body">{children}</div>
    </div>
  );
}

// ───────────── Stepper rail ─────────────
function StepperRail({ steps, current, maxReached }) {
  return (
    <aside className="rail">
      <div className="rail-brand">
        <FigafMark size={26} />
        <div className="rail-brand-text">
          <span className="t1">Figaf Manager</span>
          <span className="t2">SAP BTP · Cloud Foundry</span>
        </div>
      </div>

      <div className="stepper">
        {steps.map((s, i) => {
          const isActive = i === current;
          const isDone = i < maxReached;
          return (
            <div key={s.id} className={`step ${isActive ? "is-active" : ""} ${isDone ? "is-done" : ""}`}>
              <div className="step-dot">
                {isDone ? <Ico.Check /> : (i + 1)}
              </div>
              <div className="step-text">
                <div className="step-label">{s.label}</div>
                {s.sub && <div className="step-sub">{s.sub}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rail-foot">
        <span>v2403-btp</span>
        <span>figaf.com</span>
      </div>
    </aside>
  );
}

// ───────────── Wizard footer (Back / Next) ─────────────
function WizardFooter({ onBack, onNext, nextLabel = "Next", backLabel = "Back", nextDisabled, showBack = true, showCancel = true, children }) {
  return (
    <div className="pane-foot">
      {showCancel && <button className="btn btn-ghost">Cancel</button>}
      <div className="spacer" />
      {children}
      {showBack && (
        <button className="btn" onClick={onBack} disabled={!onBack}>
          <Ico.ArrowLeft /> {backLabel}
        </button>
      )}
      <button className="btn btn-primary" onClick={onNext} disabled={nextDisabled}>
        {nextLabel} <Ico.ArrowRight />
      </button>
    </div>
  );
}

// ───────────── Terminal drawer ─────────────
function TerminalDrawer({ open, onToggle, lines, currentCmd }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, open]);

  return (
    <>
      <div className={`terminal-bar ${open ? "open" : ""}`} onClick={onToggle}>
        <span className="chev"><Ico.Chev /></span>
        <span className="tb-dot" />
        <span className="tb-cmd">
          {currentCmd || "CLI details"}
        </span>
        <span className="tb-actions" onClick={(e) => e.stopPropagation()}>
          <button title="Copy"><Ico.Copy /></button>
          <button title="Clear"><Ico.Trash /></button>
        </span>
      </div>
      {open && (
        <div className="terminal" ref={ref}>
          {lines.map((l, i) => (
            <div key={i}>
              {l.type === "cmd" && (
                <>
                  <span className="t-prompt">PS</span>{" "}
                  <span className="t-path">{l.cwd || "C:\\Figaf"}</span>
                  <span className="t-muted"> &gt; </span>
                  <span className="t-cmd">{l.text}</span>
                </>
              )}
              {l.type === "out" && <span>{l.text}</span>}
              {l.type === "ok" && <span className="t-ok">{l.text}</span>}
              {l.type === "warn" && <span className="t-warn">{l.text}</span>}
              {l.type === "err" && <span className="t-err">{l.text}</span>}
              {l.type === "dim" && <span className="t-dim">{l.text}</span>}
            </div>
          ))}
          <div>
            <span className="t-prompt">PS</span>{" "}
            <span className="t-path">C:\Figaf</span>
            <span className="t-muted"> &gt; </span>
            <span style={{ display: "inline-block", width: 7, height: 13, background: "#D6DEEA", verticalAlign: "-2px", animation: "spin 1s steps(2) infinite", opacity: .8 }} />
          </div>
        </div>
      )}
    </>
  );
}

// ───────────── Check row (used for prereqs & progress) ─────────────
function CheckRow({ status, title, sub, meta }) {
  const iconClass = `check-icon ${status}`;
  let icon;
  if (status === "done") icon = <Ico.Check />;
  else if (status === "running") icon = <Ico.Spinner />;
  else if (status === "error") icon = <Ico.X />;
  else icon = <Ico.Dot style={{ opacity: .5 }} />;

  return (
    <div className="check-row">
      <div className={iconClass}>{icon}</div>
      <div>
        <div className="check-title">{title}</div>
        {sub && <div className="check-sub">{sub}</div>}
      </div>
      {meta && <div className="check-meta">{meta}</div>}
    </div>
  );
}

Object.assign(window, {
  Ico, FigafMark, WinFrame, StepperRail, WizardFooter, TerminalDrawer, CheckRow,
});
