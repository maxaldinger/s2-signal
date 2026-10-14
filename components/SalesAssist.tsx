"use client";

import { useEffect, useRef, useState } from "react";
import {
  Send,
  Loader2,
  RotateCcw,
  ArrowUpRight,
  Sparkles,
  Plus,
  Trash2,
  Copy,
  ChevronDown,
  Users,
  Lightbulb,
  FileSpreadsheet,
  FileDown,
  Gauge,
  Target,
  Clock,
  TrendingUp,
  Pencil,
  Database,
  Server,
  ShieldAlert,
} from "lucide-react";
import type { LiveCitation } from "@/lib/types";
import { openPocPdf, type PocPlan } from "@/lib/pocPdf";
import { openRoiPdf, S2_PRICING, S2_SIZES } from "@/lib/roiPdf";

// ---------------------------------------------------------------------------
// Modes — chat modes stream a conversation; tool modes render structured UIs.
// ---------------------------------------------------------------------------
const MODES: { id: string; label: string; dot: string }[] = [
  { id: "ask", label: "Ask Anything", dot: "#9aa3b2" },
  { id: "lou", label: "LOU", dot: "#06b6d4" },
  { id: "meddpicc", label: "MEDDPICC", dot: "#f59e0b" },
  { id: "threading", label: "Threading", dot: "#8b5cf6" },
  { id: "poc", label: "POC Plan", dot: "#10b981" },
  { id: "roi", label: "ROI Calculator", dot: "#22d3ee" },
];
const CHAT_MODES = new Set(["ask"]);

const TONES = ["Direct", "Consultative", "Concise", "Technical"];
// Must match PERSONAS in app/api/assist/route.ts.
const PERSONAS = [
  "VP Engineering",
  "CTO",
  "Chief Data Officer / VP Data",
  "Head of Data Platform",
  "Staff Data Engineer / DBA",
  "AI / ML Platform Lead",
  "Security Lead",
];

interface Ctx {
  tone: string;
  persona: string;
}

async function postAssist(body: Record<string, unknown>) {
  const res = await fetch("/api/assist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return await res.json();
  } catch {
    return { error: `HTTP ${res.status} — ${res.statusText || "non-JSON response"}` };
  }
}

// ---------------------------------------------------------------------------
// Shared UI
// ---------------------------------------------------------------------------
function Notice({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-relaxed text-amber-300">
      {text}
    </div>
  );
}

function GenerateButton({
  onClick,
  loading,
  disabled,
  label,
}: {
  onClick: () => void;
  loading: boolean;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="inline-flex items-center gap-2 rounded-lg border border-neon-600/50 bg-neon-500/15 px-5 py-2.5 text-sm font-semibold text-neon-300 shadow-glow-sm transition-all hover:bg-neon-500/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
      {label}
    </button>
  );
}

function ToolHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-lg font-bold text-ink-50">{title}</h3>
      <p className="mt-0.5 text-sm text-ink-400">{desc}</p>
    </div>
  );
}

const notesArea =
  "w-full resize-none rounded-xl border border-ink-700 bg-ink-950 px-4 py-3 text-sm text-ink-100 placeholder:text-ink-500 focus:border-neon-600/50 focus:outline-none";
const inputCls =
  "rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-neon-600/50 focus:outline-none";

// ---------------------------------------------------------------------------
// Chat tool (Ask / Cold Email / Objections / Live Research)
// ---------------------------------------------------------------------------
type Msg = {
  role: "user" | "assistant" | "notice";
  content: string;
  citations?: LiveCitation[];
};

const QUICK = [
  {
    label: "Draft a cold email",
    prompt:
      "Draft a cold email to a VP of Engineering at a 200-engineer fintech that just raised a Series C and is hiring data-platform engineers. Angle (frame it as a hypothesis, not a fact about them): customer-facing analytics stitched across Postgres replicas, a warehouse and a cache kept in sync tend to get slower and costlier as data and users grow — SingleStore can serve that workload from one engine. Use at most one published proof point, stated with what it measured.",
  },
  {
    label: "Prep a discovery call",
    prompt:
      "Plan a 30-minute first discovery call with a Head of Data Platform at a Series C marketplace company — agenda, the five questions that matter, and what good answers sound like.",
  },
];

// Objection library — the pushback SingleStore reps actually hear. Each prompt
// carries the fair framing from the COMPETITIVE section so the answer names
// where the alternative is genuinely strong.
const OBJECTIONS = [
  {
    label: '"We already have Snowflake"',
    prompt:
      'Prospect says: "We already have Snowflake — why would we add SingleStore?" Handle it fairly: Snowflake is strong for large-scale batch analytics and governance and usually stays; SingleStore sits beside it for millisecond, high-concurrency, customer-facing queries on fresh data plus transactions (Snowflake partnership, Iceberg). Position as complement first.',
  },
  {
    label: '"Postgres is fine"',
    prompt:
      'Prospect says: "Postgres is fine for us." Handle it fairly: Postgres has the biggest ecosystem and is the right default for many workloads. Find where it stops being fine — single-writer limits, analytics on the same data, replicas and caches added to cope — and use only published proof (e.g. Factors.AI) stated with what it measured.',
  },
  {
    label: '"ClickHouse is cheaper"',
    prompt:
      'Prospect says: "ClickHouse is cheaper." Handle it fairly: ClickHouse is very strong, cost-efficient columnar OLAP for append-heavy analytics. SingleStore\'s angle is mutable data (updates/upserts), transactions, joins and a MySQL-compatible app database in the same engine — compare the cost of the whole stack serving the workload, not cost per query.',
  },
  {
    label: '"Another vendor / migration risk"',
    prompt:
      'Prospect says: "We don\'t want another vendor, and migration is risky." Handle it honestly: acknowledge SingleStore is smaller than the big platforms; reduce risk by moving one painful workload first (not a big-bang migration), MySQL wire compatibility, Pipelines/Flow for loading and CDC, and a POC against SLAs they agree up front. No promised speedups before their own test.',
  },
  {
    label: '"We use Pinecone for vectors"',
    prompt:
      'Prospect says: "We already use Pinecone for vectors." Handle it fairly: Pinecone is purpose-built vector tooling. SingleStore\'s angle is vectors next to the operational and analytical data with SQL filters and joins in one query and no sync pipeline. Do not overclaim hybrid ranking (docs describe filters applied after the indexed vector search).',
  },
  {
    label: '"MySQL compatibility gaps"',
    prompt:
      'Prospect says: "SingleStore isn\'t fully MySQL compatible — our queries will break." Handle it honestly: SingleStore is MySQL wire compatible and supports a broad subset, not all, of MySQL syntax. Customers such as Fathom and Factors.AI cite no-rewrite migrations; offer to run their real query set in week 1 of a POC and log every rewrite. Never claim full compatibility.',
  },
];

function ChatTool({ ctx }: { ctx: Ctx }) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Bumped on clear so a late in-flight response can't append an orphan
  // assistant message into a fresh conversation.
  const generation = useRef(0);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || loading) return;
    const gen = generation.current;
    const history = messages.filter((m) => m.role !== "notice");
    setMessages([...messages, { role: "user", content }]);
    setInput("");
    setLoading(true);
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    const data = await postAssist({
      mode: "ask",
      tone: ctx.tone,
      persona: ctx.persona,
      messages: [...history, { role: "user", content }].map((m) => ({
        role: m.role,
        content: m.content,
      })),
    }).catch(() => ({ error: "Network error — try again." }));

    if (gen !== generation.current) return; // conversation cleared mid-flight

    setMessages((m) => {
      const next: Msg[] = [
        ...m,
        data.text
          ? { role: "assistant" as const, content: data.text, citations: data.citations }
          : { role: "notice" as const, content: data.error || "No response." },
      ];
      if (data.text && data.truncated) {
        next.push({
          role: "notice",
          content:
            "⚠ This answer was cut off by the token limit — treat it as incomplete and ask a narrower follow-up.",
        });
      }
      return next;
    });
    setLoading(false);
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  const quick = (q: (typeof QUICK)[number]) => {
    if (q.prompt) send(q.prompt);
    else inputRef.current?.focus();
  };

  return (
    <div>
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-center">
          <h2 className="font-mono text-2xl font-bold tracking-tight text-ink-50 sm:text-3xl">
            what do you need<span className="text-neon-400">?</span>
          </h2>
          <p className="mt-2 text-sm text-ink-400">
            Your AI sales engineer for SingleStore — answers grounded in live web search.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {QUICK.map((q) => (
              <button
                key={q.label}
                onClick={() => quick(q)}
                className="rounded-full border border-ink-700 bg-ink-900 px-4 py-2 text-sm font-medium text-ink-300 transition-colors hover:border-neon-600/40 hover:text-neon-300"
              >
                {q.label}
              </button>
            ))}
          </div>
          <p className="mt-5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-500">
            handle an objection
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {OBJECTIONS.map((q) => (
              <button
                key={q.label}
                onClick={() => quick(q)}
                className="rounded-full border border-ink-700 bg-ink-900 px-4 py-2 text-sm font-medium text-ink-300 transition-colors hover:border-neon-600/40 hover:text-neon-300"
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="mb-4 space-y-4">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-neon-600/40 bg-neon-500/10 px-4 py-2.5 text-sm leading-relaxed text-ink-100">
                  {m.content}
                </div>
              </div>
            ) : m.role === "notice" ? (
              <Notice key={i} text={m.content} />
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-ink-700 bg-ink-900 px-4 py-3">
                  <div className="whitespace-pre-wrap text-sm leading-relaxed text-ink-100">
                    {m.content}
                  </div>
                  {m.citations && m.citations.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-ink-700 pt-2">
                      {m.citations.map((c) => (
                        <a
                          key={c.url}
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={c.title}
                          className="inline-flex max-w-[200px] items-center gap-0.5 truncate rounded border border-ink-700 bg-ink-950 px-1.5 py-0.5 font-mono text-[10px] text-ink-400 hover:text-neon-300"
                        >
                          <span className="truncate">{c.source}</span>
                          <ArrowUpRight className="h-2.5 w-2.5 shrink-0" />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ),
          )}
          {loading && (
            <div className="flex items-center gap-2 font-mono text-xs text-neon-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              ▸ thinking…
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      {/* Composer */}
      <div className="rounded-2xl border border-ink-700 bg-ink-950 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={2}
            placeholder="What do you need? (Shift+Enter for newline)"
            className="flex-1 resize-none bg-transparent px-2 py-1.5 font-mono text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none"
          />
          {messages.length > 0 && (
            <button
              onClick={() => {
                generation.current++;
                setMessages([]);
                setLoading(false);
              }}
              disabled={loading}
              title={loading ? "Wait for the current response" : "Clear conversation"}
              className="rounded-lg border border-ink-700 p-2 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || loading}
            className="inline-flex items-center justify-center rounded-lg border border-neon-600/50 bg-neon-500/15 p-2.5 text-neon-300 transition-all hover:bg-neon-500/25 disabled:opacity-40"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LOU tool — Letter of Understanding builder with branded Excel export
// ---------------------------------------------------------------------------
interface Issue {
  issue: string;
  solution: string;
  category: string;
  priority: string;
  timeframe: string;
}
const PRIO_COLOR: Record<string, string> = {
  High: "text-red-400",
  Medium: "text-amber-400",
  Low: "text-neon-400",
};

function LouTool({ ctx }: { ctx: Ctx }) {
  const [notes, setNotes] = useState("");
  const [meetingDate, setMeetingDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState(false);

  const generate = async () => {
    if (!notes.trim()) return;
    setLoading(true);
    setError("");
    const data = await postAssist({
      mode: "lou",
      notes,
      tone: ctx.tone,
      persona: ctx.persona,
    }).catch(() => ({ error: "Network error." }));
    setLoading(false);
    if (data.data?.issues) {
      setIssues(data.data.issues);
      setEditing(false);
    } else setError(data.error || "Could not generate.");
  };

  const update = (i: number, key: keyof Issue, val: string) =>
    setIssues((arr) => arr!.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));

  const exportXlsx = async () => {
    if (!issues || exporting) return;
    setExporting(true);
    try {
      const { Workbook } = await import("exceljs");
      const wb = new Workbook();
      wb.creator = "S2 Signal";
      wb.created = new Date();
      const ws = wb.addWorksheet("Letter of Understanding", {
        views: [{ state: "frozen", ySplit: 4 }],
      });

      const BRAND = "FF6D1FC4"; // SingleStore purple (matches the PDF exports)
      const WHITE = "FFFFFFFF";
      const BORDER = "FFD9DEE8";
      const border = {
        top: { style: "thin" as const, color: { argb: BORDER } },
        left: { style: "thin" as const, color: { argb: BORDER } },
        bottom: { style: "thin" as const, color: { argb: BORDER } },
        right: { style: "thin" as const, color: { argb: BORDER } },
      };
      const solid = (argb: string) =>
        ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });

      // A is a slim left gutter; B–F hold the content.
      ws.columns = [
        { width: 2.5 },
        { width: 48 },
        { width: 44 },
        { width: 24 },
        { width: 12 },
        { width: 22 },
      ];

      const fmt = (iso: string) => {
        const d = iso ? new Date(`${iso}T00:00:00`) : new Date();
        return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
      };

      ws.getCell("B1").value = `Last Updated: ${fmt(new Date().toISOString().slice(0, 10))}`;
      ws.getCell("B1").font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF64748B" } };

      ws.mergeCells("B2:F2");
      const title = ws.getCell("B2");
      title.value = "Letter of Understanding";
      title.fill = solid(BRAND);
      title.font = { name: "Calibri", size: 20, bold: true, color: { argb: WHITE } };
      title.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      ws.getRow(2).height = 40;

      ws.mergeCells("B3:F3");
      const intro = ws.getCell("B3");
      intro.value =
        `On ${fmt(meetingDate)}, SingleStore met with your team to understand your critical business issues and how SingleStore can help. ` +
        `Please correct anything we got wrong, add anything we missed, and provide any additional context.`;
      intro.font = { name: "Calibri", size: 11, color: { argb: "FF334155" } };
      intro.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      ws.getRow(3).height = 48;

      const headers = ["Critical Business Issue", "Can we help? If so, how?", "Category", "Priority", "Timeframe"];
      const headRow = ws.getRow(4);
      headers.forEach((h, i) => {
        const c = headRow.getCell(i + 2);
        c.value = h;
        c.fill = solid(BRAND);
        c.font = { name: "Calibri", size: 12, bold: true, color: { argb: WHITE } };
        c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        c.border = border;
      });
      headRow.height = 26;

      const PRIO_FILL: Record<string, string> = { High: "FFFCE8E6", Medium: "FFFFF4E0", Low: "FFE7F6EC" };
      const PRIO_TEXT: Record<string, string> = { High: "FFB91C1C", Medium: "FFB45309", Low: "FF047857" };
      const lines = (txt: string, width: number) => Math.max(1, Math.ceil((txt || "").length / (width * 1.1)));

      issues.forEach((it, idx) => {
        const r = ws.getRow(5 + idx);
        [it.issue, it.solution, it.category, it.priority, it.timeframe].forEach((val, ci) => {
          const c = r.getCell(ci + 2);
          c.value = val || "";
          c.border = border;
          c.font = { name: "Calibri", size: 10, color: { argb: "FF0F172A" } };
          c.alignment = { vertical: "top", horizontal: ci <= 1 ? "left" : "center", wrapText: true };
        });
        const p = r.getCell(5);
        if (PRIO_FILL[it.priority]) {
          p.fill = solid(PRIO_FILL[it.priority]);
          p.font = { name: "Calibri", size: 10, bold: true, color: { argb: PRIO_TEXT[it.priority] } };
          p.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        }
        r.height = Math.min(240, Math.max(lines(it.issue, 48), lines(it.solution, 44)) * 13.5 + 8);
      });

      const last = 4 + issues.length;
      for (let row = 5; row <= last; row++) {
        ws.getCell(`D${row}`).dataValidation = {
          type: "list", allowBlank: true, showErrorMessage: false,
          // Must match LOU_CATEGORIES in app/api/assist/route.ts.
          formulae: ['"Performance & Concurrency,Data Freshness & Ingest,Cost & Consolidation,AI / Vector & Search,Migration & Operations"'],
        };
        ws.getCell(`E${row}`).dataValidation = {
          type: "list", allowBlank: true, showErrorMessage: false,
          formulae: ['"High,Medium,Low"'],
        };
      }

      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(
        new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `s2-lou-${meetingDate || "draft"}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Could not build the Excel file. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  if (!issues || editing) {
    return (
      <div>
        <ToolHeader
          title="Letter of Understanding Builder"
          desc="Paste meeting notes or a transcript to generate a structured LOU table you can edit and export to a branded Excel file."
        />
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={10}
          placeholder="Paste meeting notes, call transcript, or key discussion points..."
          className={notesArea}
        />
        {error && <div className="mt-3"><Notice text={error} /></div>}
        <div className="mt-3">
          <GenerateButton onClick={generate} loading={loading} disabled={!notes.trim()} label="Generate LOU" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <ToolHeader
        title="Letter of Understanding Builder"
        desc="Review and edit the table, then export a branded Excel file ready to send."
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
            meeting date
          </span>
          <input
            type="date"
            value={meetingDate}
            onChange={(e) => setMeetingDate(e.target.value)}
            className={`${inputCls} text-ink-200`}
          />
        </label>
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <button
            onClick={() => setEditing(true)}
            className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm font-medium text-ink-300 hover:bg-ink-800"
          >
            Edit Notes
          </button>
          <button
            onClick={() =>
              setIssues([...issues, { issue: "", solution: "", category: "", priority: "Medium", timeframe: "" }])
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm font-medium text-ink-300 hover:bg-ink-800"
          >
            <Plus className="h-4 w-4" /> Add Issue
          </button>
        </div>
        <button
          onClick={exportXlsx}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-neon-600/50 bg-neon-500/15 px-3 py-1.5 text-sm font-medium text-neon-300 hover:bg-neon-500/25 disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}{" "}
          Export Excel
        </button>
      </div>
      {error && <div className="mb-3"><Notice text={error} /></div>}
      <div className="overflow-x-auto rounded-xl border border-ink-700 bg-ink-900">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-ink-700 bg-ink-950 text-left font-mono text-[11px] font-semibold uppercase tracking-wide text-ink-400">
              <th className="w-[28%] p-3">Critical Business Issue</th>
              <th className="w-[36%] p-3">Can we help? If so, how?</th>
              <th className="p-3">Category</th>
              <th className="p-3">Priority</th>
              <th className="p-3">Timeframe</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {issues.map((r, i) => (
              <tr key={i} className="border-b border-ink-700 align-top last:border-0">
                <td className="p-2"><Cell value={r.issue} onChange={(v) => update(i, "issue", v)} /></td>
                <td className="p-2"><Cell value={r.solution} onChange={(v) => update(i, "solution", v)} /></td>
                <td className="p-2"><Cell value={r.category} onChange={(v) => update(i, "category", v)} /></td>
                <td className="p-2">
                  <select
                    value={r.priority}
                    onChange={(e) => update(i, "priority", e.target.value)}
                    className={`rounded-md border border-ink-700 bg-ink-950 px-1.5 py-1 text-xs font-semibold ${PRIO_COLOR[r.priority] || "text-ink-300"}`}
                  >
                    <option>High</option>
                    <option>Medium</option>
                    <option>Low</option>
                  </select>
                </td>
                <td className="p-2"><Cell value={r.timeframe} onChange={(v) => update(i, "timeframe", v)} /></td>
                <td className="p-2">
                  <button
                    onClick={() => setIssues(issues.filter((_, idx) => idx !== i))}
                    className="rounded p-1 text-ink-500 hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={Math.max(2, Math.ceil((value?.length || 0) / 38))}
      className="w-full resize-none rounded-md border border-transparent bg-transparent p-1.5 text-sm leading-relaxed text-ink-200 hover:border-ink-700 focus:border-neon-600/50 focus:bg-ink-950 focus:outline-none"
    />
  );
}

// ---------------------------------------------------------------------------
// MEDDPICC tool
// ---------------------------------------------------------------------------
// `hint` = what good evidence looks like on a SingleStore deal; shown as the
// notes placeholder so an empty element still tells the rep what to discover.
const MEDD = [
  {
    key: "metrics",
    letter: "M",
    label: "Metrics",
    hint: "e.g. p95 dashboard query 6s at 300 concurrent users, target <1s; data 20 min stale; ~$40K/mo across Aurora replicas + Elasticsearch + Redis; 2 engineers on pipelines",
  },
  {
    key: "economicBuyer",
    letter: "E",
    label: "Economic Buyer",
    hint: "e.g. CTO / VP Engineering / CDO / VP Data who owns database and data-platform budget — met? agreed the business case?",
  },
  {
    key: "decisionCriteria",
    letter: "D",
    label: "Decision Criteria",
    hint: "e.g. latency at concurrency on their real queries, MySQL compatibility of the query set, vector + SQL in one engine, TCO vs current stack, BYOC / security requirements",
  },
  {
    key: "decisionProcess",
    letter: "D",
    label: "Decision Process",
    hint: "e.g. 2-week POC on one workload with agreed SLAs → readout to CTO → architecture review → sign-off; who runs each step and when",
  },
  {
    key: "paperProcess",
    letter: "P",
    label: "Paper Process",
    hint: "e.g. security review + DPA, procurement steps, AWS Marketplace vs direct, on-demand vs 1-year committed credits, signer and timing",
  },
  {
    key: "identifyPain",
    letter: "I",
    label: "Implicate the Pain",
    hint: "e.g. customer-facing dashboards time out at peak; Postgres single writer maxed; Elasticsearch cluster cost; three stores kept in sync by hand — and what it costs the business",
  },
  {
    key: "champion",
    letter: "C",
    label: "Champion",
    hint: "e.g. head of data platform / data engineering — has influence, has the pain, actively selling internally?",
  },
  {
    key: "competition",
    letter: "C",
    label: "Competition",
    hint: "e.g. status quo / build-it-yourself, Snowflake or Databricks for serving, ClickHouse, Postgres/Aurora, Elasticsearch, Pinecone — where each is genuinely strong",
  },
] as const;
type Elem = { status: string; notes: string; suggestions?: string[] };
const STATUS_STYLE: Record<string, string> = {
  strong: "bg-neon-500/15 text-neon-300",
  weak: "bg-amber-500/15 text-amber-400",
  missing: "bg-red-500/15 text-red-400",
  not_set: "bg-ink-800 text-ink-400",
};

function MeddpiccTool({ ctx }: { ctx: Ctx }) {
  const [account, setAccount] = useState("");
  const [notes, setNotes] = useState("");
  const [elements, setElements] = useState<Record<string, Elem> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const run = async () => {
    if (!notes.trim()) return;
    setLoading(true);
    setError("");
    const data = await postAssist({ mode: "meddpicc", account, notes, tone: ctx.tone, persona: ctx.persona }).catch(() => ({ error: "Network error." }));
    setLoading(false);
    if (data.data?.elements) setElements(data.data.elements);
    else setError(data.error || "Could not analyze.");
  };

  const els = elements || {};
  const get = (k: string): Elem => (els[k] as Elem) || { status: "not_set", notes: "" };
  const counts = MEDD.reduce(
    (a, m) => {
      const s = get(m.key).status || "not_set";
      a[s] = (a[s] || 0) + 1;
      return a;
    },
    {} as Record<string, number>,
  );
  // Strength-weighted: strong = full credit, weak = half, missing/not_set = none.
  const strength = (counts.strong || 0) + 0.5 * (counts.weak || 0);
  const pct = Math.round((strength / 8) * 100);
  const label = pct === 0 ? "Not Started" : pct < 40 ? "Early" : pct < 70 ? "Developing" : "Well Qualified";

  const copy = async () => {
    const txt =
      `MEDDPICC — ${account || "Account"}\n\n` +
      MEDD.map((m) => `${m.label} [${get(m.key).status}]: ${get(m.key).notes || "—"}`).join("\n\n");
    try {
      await navigator.clipboard.writeText(txt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Copy failed — select the text manually.");
    }
  };

  const updateEl = (k: string, patch: Partial<Elem>) =>
    setElements((e) => ({ ...(e || {}), [k]: { ...get(k), ...patch } }));

  // Append a suggestion into the element's notes and remove it from the list.
  const addSuggestion = (k: string, idx: number) => {
    const cur = get(k);
    const sug = cur.suggestions?.[idx];
    if (!sug) return;
    const notes = cur.notes?.trim() ? `${cur.notes.trim()}\n- ${sug}` : `- ${sug}`;
    updateEl(k, { notes, suggestions: (cur.suggestions || []).filter((_, i) => i !== idx) });
  };

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <ToolHeader
          title="MEDDPICC Scorecard"
          desc="Paste meeting notes and hit Analyze — only the topics you actually discussed get filled in. Edit or add to any field after."
        />
        {elements && (
          <button
            onClick={copy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm font-medium text-ink-300 hover:bg-ink-800"
          >
            <Copy className="h-4 w-4" /> {copied ? "Copied!" : "Copy"}
          </button>
        )}
      </div>

      <input
        value={account}
        onChange={(e) => setAccount(e.target.value)}
        placeholder="Account name (e.g. Lattice)"
        className={`${inputCls} mb-3 w-full px-3.5 py-2.5`}
      />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={5}
        placeholder="Paste meeting notes, call transcripts, or email threads here. AI will only fill in the MEDDPICC fields that were actually discussed..."
        className={notesArea}
      />
      {error && <div className="mt-3"><Notice text={error} /></div>}
      <div className="mt-3">
        <GenerateButton onClick={run} loading={loading} disabled={!notes.trim()} label="Analyze & Fill Scorecard" />
      </div>

      {/* Deal Qualification tracker */}
      <div className="mt-6 rounded-xl border border-ink-700 bg-ink-900 p-5">
        <div className="flex items-center justify-between">
          <h4 className="flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-ink-200">
            <span className="text-neon-400">◎</span> deal qualification
          </h4>
          <span className={`font-mono text-sm font-bold ${pct === 0 ? "text-red-400" : pct < 75 ? "text-amber-400" : "text-neon-400"}`}>
            {pct}% — {label}
          </span>
        </div>
        <div className="my-3 h-2 overflow-hidden rounded-full bg-ink-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-neon-600 to-neon-400"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex flex-wrap gap-4 font-mono text-xs">
          <span className="text-neon-400">{counts.strong || 0} strong</span>
          <span className="text-amber-400">{counts.weak || 0} weak</span>
          <span className="text-red-400">{counts.missing || 0} missing</span>
          <span className="text-ink-500">{counts.not_set || 8} not set</span>
        </div>
      </div>

      {/* Element rows */}
      <div className="mt-3 space-y-2">
        {MEDD.map((m) => {
          const el = get(m.key);
          const isOpen = open === m.key;
          return (
            <div key={m.key + m.label} className="overflow-hidden rounded-xl border border-ink-700 bg-ink-900">
              <button
                onClick={() => setOpen(isOpen ? null : m.key)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ink-800 font-mono text-xs font-bold text-ink-400">
                  {m.letter}
                </span>
                <span className="flex-1 text-sm font-semibold text-ink-100">{m.label}</span>
                <span className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold uppercase ${STATUS_STYLE[el.status] || STATUS_STYLE.not_set}`}>
                  {(el.status || "not_set").replace("_", " ")}
                </span>
                <ChevronDown className={`h-4 w-4 text-ink-400 transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>
              {isOpen && (
                <div className="border-t border-ink-700 p-4">
                  <div className="mb-2 flex gap-1.5">
                    {["strong", "weak", "missing", "not_set"].map((s) => (
                      <button
                        key={s}
                        onClick={() => updateEl(m.key, { status: s })}
                        className={`rounded px-2 py-0.5 font-mono text-[10px] font-bold uppercase ${el.status === s ? STATUS_STYLE[s] : "bg-ink-800 text-ink-500"}`}
                      >
                        {s.replace("_", " ")}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={el.notes}
                    onChange={(e) => updateEl(m.key, { notes: e.target.value })}
                    rows={3}
                    placeholder={`Notes — what you learned, or what to discover… ${m.hint}`}
                    className={`${notesArea} rounded-lg px-3 py-2 text-ink-200`}
                  />
                  {el.suggestions && el.suggestions.length > 0 && (
                    <div className="mt-3">
                      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-neon-400">
                        <Lightbulb className="h-3.5 w-3.5" /> how to strengthen this
                      </div>
                      <ul className="space-y-1.5">
                        {el.suggestions.map((s, si) => (
                          <li
                            key={si}
                            className="flex items-start gap-2 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm leading-relaxed text-ink-300"
                          >
                            <span className="mt-0.5 shrink-0 text-neon-400">→</span>
                            <span className="flex-1">{s}</span>
                            <button
                              onClick={() => addSuggestion(m.key, si)}
                              title="Add to notes"
                              className="shrink-0 rounded-md border border-ink-700 bg-ink-900 px-2 py-0.5 text-[11px] font-medium text-ink-400 transition-colors hover:border-neon-600/40 hover:text-neon-300"
                            >
                              + Add
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Threading tool
// ---------------------------------------------------------------------------
interface Stake { name: string; title: string; notes: string; }
interface ThreadResult {
  summary: string;
  stakeholders: { name: string; title: string; role: string; disposition: string; strategy: string }[];
  gaps: string[];
  nextActions: string[];
}
function ThreadingTool({ ctx }: { ctx: Ctx }) {
  const [rows, setRows] = useState<Stake[]>([{ name: "", title: "", notes: "" }]);
  const [result, setResult] = useState<ThreadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    const valid = rows.filter((r) => r.name.trim() || r.title.trim());
    if (valid.length === 0) return;
    const notes =
      "Stakeholders:\n" +
      valid.map((r) => `- ${r.name || "?"} (${r.title || "?"}): ${r.notes || "no notes"}`).join("\n");
    setLoading(true);
    setError("");
    const data = await postAssist({ mode: "threading", notes, tone: ctx.tone, persona: ctx.persona }).catch(() => ({ error: "Network error." }));
    setLoading(false);
    if (data.data?.stakeholders) setResult(data.data);
    else setError(data.error || "Could not analyze.");
  };

  return (
    <div>
      <ToolHeader
        title="Multi-Threading Analysis"
        desc="Add the people in the deal. We'll classify the buying committee, score coverage, and recommend how to multi-thread."
      />
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-col gap-2 sm:flex-row">
            <input
              value={r.name}
              onChange={(e) => setRows(rows.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))}
              placeholder="Name"
              className={`${inputCls} sm:w-40`}
            />
            <input
              value={r.title}
              onChange={(e) => setRows(rows.map((x, idx) => (idx === i ? { ...x, title: e.target.value } : x)))}
              placeholder="Title"
              className={`${inputCls} sm:w-48`}
            />
            <input
              value={r.notes}
              onChange={(e) => setRows(rows.map((x, idx) => (idx === i ? { ...x, notes: e.target.value } : x)))}
              placeholder="Notes (e.g., met at discovery call, very engaged)"
              className={`${inputCls} flex-1`}
            />
            <button
              onClick={() => setRows(rows.length > 1 ? rows.filter((_, idx) => idx !== i) : rows)}
              className="rounded-lg border border-ink-700 p-2 text-ink-500 hover:text-red-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => setRows([...rows, { name: "", title: "", notes: "" }])}
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm font-medium text-ink-300 hover:bg-ink-800"
        >
          <Plus className="h-4 w-4" /> Add Stakeholder
        </button>
        <GenerateButton onClick={run} loading={loading} label="Analyze Committee" />
      </div>
      {error && <div className="mt-3"><Notice text={error} /></div>}

      {result && (
        <div className="mt-6 space-y-4">
          <div className="rounded-xl border border-ink-700 bg-ink-900 p-4 text-sm leading-relaxed text-ink-300">
            {result.summary}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {result.stakeholders.map((s, i) => (
              <div key={i} className="rounded-xl border border-ink-700 bg-ink-900 p-4">
                <div className="flex items-center justify-between">
                  <h5 className="text-sm font-semibold text-ink-100">{s.name}</h5>
                  <span className="rounded bg-neon-500/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-neon-300">
                    {s.role}
                  </span>
                </div>
                <p className="text-xs text-ink-500">{s.title} · {s.disposition}</p>
                <p className="mt-2 text-xs leading-relaxed text-ink-400">{s.strategy}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <ListCard icon={<Users className="h-4 w-4 text-amber-400" />} title="coverage gaps" items={result.gaps} />
            <ListCard icon={<Sparkles className="h-4 w-4 text-neon-400" />} title="next actions" items={result.nextActions} />
          </div>
        </div>
      )}
    </div>
  );
}

function ListCard({ icon, title, items }: { icon: React.ReactNode; title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
      <h4 className="mb-2 flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-ink-200">
        {icon} {title}
      </h4>
      <ul className="space-y-1.5 text-sm text-ink-300">
        {items?.map((g, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-ink-500">•</span> {g}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROI Calculator — live, client-side. No AI call; recomputes as you type.
// A SingleStore consolidation / TCO model: spend retired on the systems being
// consolidated (+ pipeline engineering time freed, in Advanced) minus the
// SingleStore cost modeled from PUBLIC list prices (S2_PRICING / S2_SIZES in
// lib/roiPdf.ts, mirrored from the PRICING section of lib/singlestore.ts).
// Every figure carries its basis, kept visibly distinct:
//   CUSTOMER ASSUMPTION — inputs about the prospect (never their known spend)
//   MODELED             — computed here
//   MEASURED            — other customers' published results; reference
//                         points only, never a forecast for this account
// Defaults are illustrative assumptions for a mid-size stack, not benchmarks.
// ---------------------------------------------------------------------------
const usd = (n: number) =>
  isFinite(n)
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "—";

const roiLabel = "mb-1.5 block text-[13px] font-medium leading-snug text-ink-200";

type Basis = "assumption" | "modeled" | "measured";
const BASIS_STYLE: Record<Basis, { label: string; cls: string }> = {
  assumption: { label: "customer assumption", cls: "border-amber-500/40 bg-amber-500/10 text-amber-300" },
  modeled: { label: "modeled", cls: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
  measured: { label: "measured", cls: "border-neon-600/40 bg-neon-500/10 text-neon-300" },
};

function BasisTag({ kind }: { kind: Basis }) {
  const b = BASIS_STYLE[kind];
  return (
    <span
      className={`ml-1.5 inline-block whitespace-nowrap rounded border px-1 py-px align-middle font-mono text-[8.5px] font-bold uppercase tracking-wider ${b.cls}`}
    >
      {b.label}
    </span>
  );
}

// Published reference points (PROOF in lib/singlestore.ts) — each stated with
// what it measured. Shown beside the model, never fed into it.
const S2_REFERENCES: { who: string; value: string; what: string }[] = [
  { who: "Armis", value: "−70%", what: "data pipeline cost vs a >$1M/yr pipeline on a 160-node Elasticsearch cluster" },
  { who: "Fathom Analytics", value: "−60%", what: "database TCO after replacing RDS MySQL + Redis + DynamoDB" },
  { who: "DirectlyApply", value: "$100K/yr", what: "saved after replacing MongoDB + Elasticsearch" },
];

function RoiSlider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  presets,
}: {
  label: React.ReactNode;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  presets?: { label: string; value: number }[];
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium leading-snug text-ink-200">{label}</span>
        <span className="shrink-0 font-mono text-sm font-bold text-neon-300">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-neon-500"
      />
      {presets && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.label}
              onClick={() => onChange(p.value)}
              className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                value === p.value
                  ? "border-neon-600/50 bg-neon-500/10 text-neon-300"
                  : "border-ink-700 text-ink-400 hover:text-ink-200"
              }`}
            >
              {p.label} · {p.value}
              {suffix}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RoiMoney({
  label,
  value,
  onChange,
}: {
  label: React.ReactNode;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      {/* The label is optional: in range mode the heading sits above the pair
          of fields, so an empty span here would just add dead space. */}
      {label ? <span className={roiLabel}>{label}</span> : null}
      <div className="flex items-center rounded-lg border border-ink-700 bg-ink-950 px-2.5 focus-within:border-neon-600/50">
        <span className="font-mono text-sm text-ink-500">$</span>
        <input
          type="number"
          min={0}
          value={value || ""}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
          className="w-full bg-transparent px-1.5 py-2 font-mono text-sm text-ink-100 focus:outline-none"
        />
      </div>
    </label>
  );
}

// Plain integer field (no $) — for counts like FTEs, GB, weeks.
function RoiNumber({
  label,
  value,
  onChange,
  suffix,
}: {
  label: React.ReactNode;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className={roiLabel}>{label}</span>
      <div className="flex items-center rounded-lg border border-ink-700 bg-ink-950 pr-2.5 focus-within:border-neon-600/50">
        <input
          type="number"
          min={0}
          value={value || ""}
          onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value))))}
          className="w-full bg-transparent px-3 py-2 font-mono text-sm text-ink-100 focus:outline-none"
        />
        {suffix && <span className="shrink-0 font-mono text-xs text-ink-500">{suffix}</span>}
      </div>
    </label>
  );
}

// SingleStore compute size, from the public list-price table.
function RoiSizePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <span className={roiLabel}>
        SingleStore cluster size <BasisTag kind="modeled" />
      </span>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {S2_SIZES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onChange(s.id)}
            className={`rounded-lg border px-2 py-1.5 text-left transition-colors ${
              value === s.id
                ? "border-neon-600/50 bg-neon-500/10 text-neon-300"
                : "border-ink-700 bg-ink-950 text-ink-400 hover:text-ink-200"
            }`}
          >
            <span className="block font-mono text-sm font-bold">{s.id}</span>
            <span className="block font-mono text-[10px] leading-tight opacity-80">${s.hourly.toFixed(2)}/h</span>
            <span className="block text-[10px] leading-tight opacity-70">{s.spec}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function sizeOf(id: string) {
  return S2_SIZES.find((s) => s.id === id) ?? S2_SIZES[2];
}

// Simple view — the two numbers you can get on a call:
//   what they spend on the systems in scope (exact, or a range on a first call)
//   × the share consolidation could retire (an assumption to validate)
//   − SingleStore at public list price for the size picked (always-on).
function RoiSimple() {
  // EXACT when the account has told you their real spend; RANGE for the usual
  // first call, where quoting one invented number is the fastest way to lose
  // the room. Range exports a column per point instead.
  const [spendMode, setSpendMode] = useState<"exact" | "range">("exact");
  const [spend, setSpend] = useState(500000);
  const [spendLow, setSpendLow] = useState(300000);
  const [spendHigh, setSpendHigh] = useState(800000);
  const [retirePct, setRetirePct] = useState(40);
  const [size, setSize] = useState("S-4");
  const [storageGb, setStorageGb] = useState(2000);
  const [copied, setCopied] = useState(false);
  const [pdfBlocked, setPdfBlocked] = useState(false);

  const sz = sizeOf(size);
  const s2ComputeYr = sz.hourly * S2_PRICING.hoursPerMonth * 12;
  const s2StorageYr = storageGb * S2_PRICING.storagePerGbMonth * 12;
  const s2CostYr = s2ComputeYr + s2StorageYr;

  // One spend figure -> the whole line of numbers.
  const modelFor = (spendYr: number) => {
    const retiredYr = spendYr * (retirePct / 100);
    return {
      spendYr,
      retiredYr,
      s2CostYr,
      netSavingsYr: retiredYr - s2CostYr,
      newRunRateYr: spendYr - retiredYr + s2CostYr,
    };
  };

  // Three points across the band: the two ends the rep picked and the midpoint.
  // Sorted so a low/high entered backwards still reads correctly.
  const [lo, hi] = spendLow <= spendHigh ? [spendLow, spendHigh] : [spendHigh, spendLow];
  const scenarios = [lo, Math.round((lo + hi) / 2), hi].map(modelFor);
  const ranged = spendMode === "range";
  // The single-number view, and the midpoint's numbers in range mode — what the
  // headline cards and the copied summary quote.
  const mid = ranged ? scenarios[1] : modelFor(spend);
  const { spendYr, retiredYr, netSavingsYr, newRunRateYr } = mid;

  const exportPdf = () => {
    const ok = openRoiPdf({
      kind: "simple",
      spendYr,
      retirePct,
      retiredYr,
      size: sz.id,
      sizeHourly: sz.hourly,
      storageGb,
      s2ComputeYr,
      s2StorageYr,
      s2CostYr,
      netSavingsYr,
      newRunRateYr,
      scenarios: ranged ? scenarios : undefined,
    });
    setPdfBlocked(!ok);
  };

  const summary = ranged
    ? `Assumed ${usd(lo)}–${usd(hi)}/yr on the systems in scope. If consolidation retires ${retirePct}% of it ` +
      `(assumption) and SingleStore runs on ${sz.id} at list price (${usd(s2CostYr)}/yr modeled), modeled net ` +
      `savings are ${usd(scenarios[0].netSavingsYr)}–${usd(scenarios[2].netSavingsYr)}/yr.`
    : `Assumed ${usd(spendYr)}/yr on the systems in scope. If consolidation retires ${retirePct}% ` +
      `(${usd(retiredYr)}, assumption) and SingleStore runs on ${sz.id} at list price (${usd(s2CostYr)}/yr modeled), ` +
      `the modeled net saving is ${usd(netSavingsYr)}/yr and the run-rate goes from ${usd(spendYr)} to ${usd(newRunRateYr)}.`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4 rounded-xl border border-ink-700 bg-ink-900/60 p-5">
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className={roiLabel}>
              Annual spend on the systems in scope <BasisTag kind="assumption" />
            </span>
            <div className="flex shrink-0 rounded-md border border-ink-700 p-0.5">
              {(["exact", "range"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setSpendMode(m)}
                  className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                    spendMode === m
                      ? "bg-neon-500/15 text-neon-300"
                      : "text-ink-500 hover:text-ink-300"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          {ranged ? (
            <div className="grid grid-cols-2 gap-3">
              <RoiMoney label="Low" value={spendLow} onChange={setSpendLow} />
              <RoiMoney label="High" value={spendHigh} onChange={setSpendHigh} />
            </div>
          ) : (
            <RoiMoney label="" value={spend} onChange={setSpend} />
          )}
        </div>
        <RoiSlider
          label={
            <>
              Share of that spend retired by consolidation <BasisTag kind="assumption" />
            </>
          }
          value={retirePct}
          onChange={setRetirePct}
          min={0}
          max={90}
          suffix="%"
        />
        <RoiSizePicker value={size} onChange={setSize} />
        <RoiNumber
          label={
            <>
              Data stored in SingleStore (compressed) <BasisTag kind="assumption" />
            </>
          }
          value={storageGb}
          onChange={setStorageGb}
          suffix="GB"
        />
        <p className="text-[11px] leading-relaxed text-ink-600">
          Spend and share retired are assumptions until the customer confirms their bill — never their known spend.
          SingleStore cost is modeled at public on-demand list price (Standard, AWS us-east-1, always-on 730 h/mo;
          storage $0.023/GB-month); committed-use discounts are not public. Pipeline engineering time, edition,
          Multi-AZ, migration effort and the 3-year view are in Advanced.
        </p>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-5">
          <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-500">
            current spend in scope <BasisTag kind="assumption" />
          </p>
          <p className="mt-1 font-mono text-2xl font-extrabold text-ink-100">
            {ranged ? `${usd(scenarios[0].spendYr)} – ${usd(scenarios[2].spendYr)}` : usd(spendYr)}
            <span className="text-sm font-semibold text-ink-500"> / yr</span>
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-500">
            OLTP, warehouse compute, search, vector, cache, ETL/CDC serving the workload
          </p>
        </div>
        <div className="rounded-xl border border-neon-600/40 bg-neon-500/10 p-5 shadow-glow-sm">
          <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-neon-400">
            net savings / yr at {retirePct}% retired <BasisTag kind="modeled" />
          </p>
          <p className={`mt-1 font-mono font-extrabold text-neon-300 ${ranged ? "text-3xl" : "text-4xl"}`}>
            {ranged
              ? `${usd(scenarios[0].netSavingsYr)} – ${usd(scenarios[2].netSavingsYr)}`
              : usd(netSavingsYr)}
          </p>
          <p className="mt-1.5 font-mono text-[12px] text-neon-400/90">
            {ranged
              ? `across ${usd(lo)}–${usd(hi)} / yr · after SingleStore ${sz.id} at ${usd(s2CostYr)} / yr list`
              : `${usd(retiredYr)} retired − SingleStore ${usd(s2CostYr)} · run-rate ${usd(spendYr)} → ${usd(newRunRateYr)} / yr`}
          </p>
        </div>
        {ranged ? (
          // The three points that get exported — what you see is the table the
          // prospect receives.
          <div className="overflow-x-auto rounded-xl border border-ink-700 bg-ink-900/60 p-5">
            <table className="w-full text-left font-mono text-[11px]">
              <thead>
                <tr className="text-ink-500">
                  <th className="pb-2 font-semibold uppercase tracking-wider">spend / yr</th>
                  <th className="pb-2 text-right font-semibold uppercase tracking-wider">retired</th>
                  <th className="pb-2 text-right font-semibold uppercase tracking-wider">singlestore</th>
                  <th className="pb-2 text-right font-semibold uppercase tracking-wider">net</th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map((x, i) => (
                  <tr key={i} className="border-t border-ink-800">
                    <td className="py-1.5 text-ink-200">{usd(x.spendYr)}</td>
                    <td className="py-1.5 text-right text-ink-400">{usd(x.retiredYr)}</td>
                    <td className="py-1.5 text-right text-ink-400">{usd(x.s2CostYr)}</td>
                    <td className={`py-1.5 text-right font-bold ${x.netSavingsYr >= 0 ? "text-neon-300" : "text-red-400"}`}>
                      {usd(x.netSavingsYr)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 rounded-xl border border-ink-700 bg-ink-900/60 p-5">
            <div>
              <p className="font-mono text-xl font-extrabold leading-none text-ink-100">{usd(s2CostYr)}</p>
              <p className="mt-1 text-[11px] leading-tight text-ink-500">
                SingleStore / yr — {sz.id} at ${sz.hourly.toFixed(2)}/h always-on + storage, list price
              </p>
            </div>
            <div>
              <p className="font-mono text-xl font-extrabold leading-none text-ink-100">{usd(retiredYr)}</p>
              <p className="mt-1 text-[11px] leading-tight text-ink-500">
                spend retired / yr ({retirePct}% of current, assumed)
              </p>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={copy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-xs font-medium text-ink-300 transition-colors hover:border-neon-600/40 hover:text-neon-200"
          >
            {copied ? "copied ✓" : "Copy summary"}
          </button>
          <button
            onClick={exportPdf}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neon-600/40 bg-neon-500/10 px-3 py-2 font-mono text-xs font-semibold text-neon-300 transition-colors hover:bg-neon-500/20"
          >
            <FileDown className="h-4 w-4" /> Download PDF
          </button>
        </div>
        {pdfBlocked && (
          <p className="text-[11px] text-amber-300/90">
            Your browser blocked the export tab — allow pop-ups for this site, then click Download PDF again.
          </p>
        )}
      </div>
    </div>
  );
}

function RoiTool() {
  const [view, setView] = useState<"simple" | "advanced">("simple");
  return (
    <div>
      <ToolHeader
        title="ROI Calculator"
        desc={
          view === "simple"
            ? "The two numbers you can get on a call — spend on the systems in scope and how much consolidation could retire — against SingleStore's public list price. Flip to Advanced for every lever."
            : "Consolidation and 3-year TCO model, live. Prospect inputs are customer assumptions and SingleStore cost is modeled from public list prices — adjust as you talk and it recomputes."
        }
      />
      <div className="mb-5 flex gap-1.5">
        {(["simple", "advanced"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-full border px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-wide transition-colors ${
              view === v
                ? "border-neon-600/50 bg-neon-500/15 text-neon-300"
                : "border-ink-700 bg-ink-950 text-ink-400 hover:text-ink-200"
            }`}
          >
            {v}
          </button>
        ))}
      </div>
      {view === "simple" ? <RoiSimple /> : <RoiAdvanced />}
    </div>
  );
}

// The systems a SingleStore serving layer typically consolidates. Spend and the
// share retired are CUSTOMER ASSUMPTIONS; the defaults below are illustrative,
// and deliberately keep most of the warehouse (it usually stays — COMPETITIVE).
interface SystemInput {
  key: string;
  label: string;
  spendYr: number;
  retirePct: number;
}
const DEFAULT_SYSTEMS: SystemInput[] = [
  { key: "oltp", label: "Operational DB (OLTP + read replicas)", spendYr: 180000, retirePct: 40 },
  { key: "warehouse", label: "Warehouse / lakehouse compute serving the app", spendYr: 240000, retirePct: 20 },
  { key: "search", label: "Search cluster (Elasticsearch / OpenSearch)", spendYr: 120000, retirePct: 100 },
  { key: "vector", label: "Vector database", spendYr: 36000, retirePct: 100 },
  { key: "cache", label: "Cache (Redis / ElastiCache)", spendYr: 48000, retirePct: 100 },
  { key: "etl", label: "ETL / CDC tooling between them", spendYr: 60000, retirePct: 50 },
];

function RoiAdvanced() {
  const [systems, setSystems] = useState<SystemInput[]>(DEFAULT_SYSTEMS);
  const [pipelineFtes, setPipelineFtes] = useState(3);
  const [loadedCost, setLoadedCost] = useState(200000);
  const [freedPct, setFreedPct] = useState(30);
  const [size, setSize] = useState("S-4");
  const [edition, setEdition] = useState<"Standard" | "Enterprise">("Standard");
  const [multiAz, setMultiAz] = useState(true);
  const [hoursMo, setHoursMo] = useState<number>(S2_PRICING.hoursPerMonth);
  const [storageGb, setStorageGb] = useState(2000);
  const [discountPct, setDiscountPct] = useState(0);
  const [migrationWeeks, setMigrationWeeks] = useState(16);
  const [copied, setCopied] = useState(false);
  const [pdfBlocked, setPdfBlocked] = useState(false);

  const setSystem = (i: number, patch: Partial<SystemInput>) =>
    setSystems((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  // Infrastructure retired: Σ spend × share retired.
  const lines = systems.map((s) => ({
    label: s.label,
    spendYr: s.spendYr,
    retirePct: s.retirePct,
    retiredYr: s.spendYr * (s.retirePct / 100),
  }));
  const currentSystemsYr = lines.reduce((a, l) => a + l.spendYr, 0);
  const retiredYr = lines.reduce((a, l) => a + l.retiredYr, 0);
  const fullyRetired = lines.filter((l) => l.spendYr > 0 && l.retirePct >= 100).length;

  // Engineering time on pipelines: FTEs × loaded cost × share freed.
  const engCostYr = pipelineFtes * loadedCost;
  const engFreedYr = engCostYr * (freedPct / 100);

  // SingleStore: list $/h × edition × Multi-AZ × hours × 12 (less any discount
  // the customer has been quoted — applied to compute credits only), plus
  // storage billed separately per GB-month.
  const sz = sizeOf(size);
  const mult =
    (edition === "Enterprise" ? S2_PRICING.enterpriseMultiplier : 1) *
    (multiAz ? S2_PRICING.multiAzMultiplier : 1);
  const s2ComputeYr = sz.hourly * mult * hoursMo * 12 * (1 - discountPct / 100);
  const s2StorageYr = storageGb * S2_PRICING.storagePerGbMonth * 12;
  const s2CostYr = s2ComputeYr + s2StorageYr;

  const grossBenefitYr = retiredYr + engFreedYr;
  const netSavingsYr = grossBenefitYr - s2CostYr;
  const migrationCost = migrationWeeks * (loadedCost / 52);
  const paybackMonths = netSavingsYr > 0 ? migrationCost / (netSavingsYr / 12) : null;
  const returnX = s2CostYr > 0 ? grossBenefitYr / s2CostYr : null;

  // 3-year view: flat run-rate, migration effort charged to year 1.
  const statusQuoYr = currentSystemsYr + engCostYr;
  const withS2Yr = statusQuoYr - grossBenefitYr + s2CostYr;
  const threeYear = [1, 2, 3].map((year) => ({
    year,
    statusQuo: statusQuoYr,
    withS2: withS2Yr + (year === 1 ? migrationCost : 0),
    cumulativeNet: year * netSavingsYr - migrationCost,
  }));
  const threeYrNet = threeYear[2].cumulativeNet;
  const paybackLabel =
    paybackMonths === null ? "no payback at these inputs" : `payback ~${Math.max(1, Math.round(paybackMonths))} mo`;

  // Annual only (plus the 3-year view) — no monthly view anywhere in the calculator.
  const summary =
    `SingleStore consolidation — modeled net savings ${usd(netSavingsYr)}/yr: ${usd(retiredYr)} of an assumed ` +
    `${usd(currentSystemsYr)}/yr in-scope spend retired, plus ${usd(engFreedYr)} of pipeline engineering time freed ` +
    `(assumption), less SingleStore ${sz.id} ${edition}${multiAz ? " Multi-AZ" : ""} at ${usd(s2CostYr)}/yr ` +
    `(${discountPct > 0 ? `list less an assumed ${discountPct}%` : "list price"}). ` +
    `With ${usd(migrationCost)} of one-time migration effort: ${paybackLabel}, 3-year cumulative ${usd(threeYrNet)}.`;

  const exportPdf = () => {
    const ok = openRoiPdf({
      kind: "advanced",
      systems: lines,
      currentSystemsYr,
      retiredYr,
      pipelineFtes,
      loadedCost,
      freedPct,
      engCostYr,
      engFreedYr,
      size: sz.id,
      sizeHourly: sz.hourly,
      edition,
      multiAz,
      hoursMo,
      storageGb,
      discountPct,
      s2ComputeYr,
      s2StorageYr,
      s2CostYr,
      grossBenefitYr,
      netSavingsYr,
      migrationWeeks,
      migrationCost,
      paybackMonths,
      returnX,
      threeYear,
    });
    setPdfBlocked(!ok);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const Stat = ({ value, label }: { value: string; label: string }) => (
    <div>
      <p className="font-mono text-2xl font-extrabold leading-none text-neon-300">{value}</p>
      <p className="mt-1 text-[11px] leading-tight text-ink-500">{label}</p>
    </div>
  );

  const toggleCls = (on: boolean) =>
    `rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors ${
      on ? "bg-neon-500/15 text-neon-300" : "text-ink-500 hover:text-ink-300"
    }`;

  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Inputs */}
        <div className="space-y-5 rounded-2xl border border-ink-700 bg-ink-900 p-5">
          <div>
            <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
              systems being consolidated <BasisTag kind="assumption" />
            </p>
            <div className="space-y-2.5">
              {systems.map((s, i) => (
                <div key={s.key} className="grid grid-cols-[1fr_84px] items-end gap-3">
                  <RoiMoney label={s.label} value={s.spendYr} onChange={(v) => setSystem(i, { spendYr: v })} />
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] font-medium leading-snug text-ink-400">retired</span>
                    <div className="flex items-center rounded-lg border border-ink-700 bg-ink-950 pr-2 focus-within:border-neon-600/50">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={s.retirePct}
                        onChange={(e) =>
                          setSystem(i, { retirePct: Math.min(100, Math.max(0, Math.round(Number(e.target.value)))) })
                        }
                        className="w-full bg-transparent px-2 py-2 font-mono text-sm text-ink-100 focus:outline-none"
                      />
                      <span className="font-mono text-xs text-ink-500">%</span>
                    </div>
                  </label>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t border-ink-800 pt-4">
            <div className="grid grid-cols-2 gap-4">
              <RoiNumber
                label={
                  <>
                    Engineers maintaining pipelines <BasisTag kind="assumption" />
                  </>
                }
                value={pipelineFtes}
                onChange={setPipelineFtes}
                suffix="FTE"
              />
              <RoiMoney label="Fully-loaded cost / engineer / yr" value={loadedCost} onChange={setLoadedCost} />
            </div>
            <div className="mt-4">
              <RoiSlider
                label={
                  <>
                    Share of that pipeline time freed <BasisTag kind="assumption" />
                  </>
                }
                value={freedPct}
                onChange={setFreedPct}
                min={0}
                max={80}
                suffix="%"
              />
            </div>
          </div>
          <div className="space-y-4 border-t border-ink-800 pt-4">
            <RoiSizePicker value={size} onChange={setSize} />
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-ink-200">Edition</span>
                <div className="flex rounded-md border border-ink-700 p-0.5">
                  {(["Standard", "Enterprise"] as const).map((e) => (
                    <button key={e} type="button" onClick={() => setEdition(e)} className={toggleCls(edition === e)}>
                      {e === "Enterprise" ? "Enterprise ×1.5" : e}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-ink-200">Availability</span>
                <div className="flex rounded-md border border-ink-700 p-0.5">
                  <button type="button" onClick={() => setMultiAz(false)} className={toggleCls(!multiAz)}>
                    single-AZ
                  </button>
                  <button type="button" onClick={() => setMultiAz(true)} className={toggleCls(multiAz)}>
                    multi-AZ ×1.3
                  </button>
                </div>
              </div>
            </div>
            <RoiSlider
              label="Hours running per month (730 = always-on)"
              value={hoursMo}
              onChange={setHoursMo}
              min={100}
              max={730}
              step={10}
              suffix="h"
            />
            <div className="grid grid-cols-2 gap-4">
              <RoiNumber
                label={
                  <>
                    Data stored (compressed) <BasisTag kind="assumption" />
                  </>
                }
                value={storageGb}
                onChange={setStorageGb}
                suffix="GB"
              />
              <RoiNumber
                label={
                  <>
                    Quoted discount vs list <BasisTag kind="assumption" />
                  </>
                }
                value={discountPct}
                onChange={(v) => setDiscountPct(Math.min(90, v))}
                suffix="%"
              />
            </div>
          </div>
          <div className="border-t border-ink-800 pt-4">
            <RoiNumber
              label={
                <>
                  One-time migration effort <BasisTag kind="assumption" />
                </>
              }
              value={migrationWeeks}
              onChange={setMigrationWeeks}
              suffix="eng-weeks"
            />
          </div>
        </div>

        {/* Outputs — annual + 3-year */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-neon-600/40 bg-neon-500/10 p-6 shadow-glow-sm">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-neon-400">
              modeled net annual savings <BasisTag kind="modeled" />
            </p>
            <p className={`mt-1 font-mono text-4xl font-extrabold tracking-tight ${netSavingsYr >= 0 ? "text-neon-200" : "text-red-300"}`}>
              {usd(netSavingsYr)}
            </p>
            <p className="mt-1 text-sm text-ink-300">
              {paybackLabel} · 3-yr cumulative{" "}
              <span className="font-semibold text-neon-300">{usd(threeYrNet)}</span>
              {returnX !== null && <> · {returnX.toFixed(1)}× return on SingleStore spend</>}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3 rounded-xl border border-ink-700 bg-ink-900 p-4">
            <Stat value={usd(currentSystemsYr)} label="in-scope spend / yr (assumed)" />
            <Stat value={usd(s2CostYr)} label={`SingleStore ${sz.id} / yr (modeled)`} />
            <Stat value={String(fullyRetired)} label="systems fully retired (assumed)" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
              <p className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                <TrendingUp className="h-3.5 w-3.5 text-neon-400" /> infra retired
              </p>
              <p className="mt-1 font-mono text-xl font-bold text-ink-100">{usd(retiredYr)}</p>
              <p className="mt-0.5 text-[11px] text-ink-500">of {usd(currentSystemsYr)}/yr in scope</p>
            </div>
            <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
              <p className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                <Clock className="h-3.5 w-3.5 text-neon-400" /> pipeline time freed
              </p>
              <p className="mt-1 font-mono text-xl font-bold text-ink-100">{usd(engFreedYr)}</p>
              <p className="mt-0.5 text-[11px] text-ink-500">
                {freedPct}% of {pipelineFtes} FTE × {usd(loadedCost)}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-xl border border-ink-700 bg-ink-900 p-4">
            <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
              3-year view <BasisTag kind="modeled" />
            </p>
            <table className="w-full text-left font-mono text-[11px]">
              <thead>
                <tr className="text-ink-500">
                  <th className="pb-2 font-semibold uppercase tracking-wider"></th>
                  <th className="pb-2 text-right font-semibold uppercase tracking-wider">status quo</th>
                  <th className="pb-2 text-right font-semibold uppercase tracking-wider">with singlestore</th>
                  <th className="pb-2 text-right font-semibold uppercase tracking-wider">cumulative net</th>
                </tr>
              </thead>
              <tbody>
                {threeYear.map((y) => (
                  <tr key={y.year} className="border-t border-ink-800">
                    <td className="py-1.5 text-ink-200">Year {y.year}</td>
                    <td className="py-1.5 text-right text-ink-400">{usd(y.statusQuo)}</td>
                    <td className="py-1.5 text-right text-ink-400">{usd(y.withS2)}</td>
                    <td className={`py-1.5 text-right font-bold ${y.cumulativeNet >= 0 ? "text-neon-300" : "text-red-400"}`}>
                      {usd(y.cumulativeNet)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10.5px] leading-snug text-ink-500">
              Flat run-rate; one-time migration ({migrationWeeks} eng-weeks = {usd(migrationCost)}) charged to year 1.
            </p>
          </div>

          <div className="rounded-xl border border-ink-700 bg-ink-950 p-4">
            <p className="text-sm leading-relaxed text-ink-300">{summary}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={copy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm font-medium text-ink-300 hover:bg-ink-800"
              >
                <Copy className="h-4 w-4" /> {copied ? "Copied!" : "Copy summary"}
              </button>
              <button
                onClick={exportPdf}
                className="inline-flex items-center gap-1.5 rounded-lg border border-neon-600/40 bg-neon-500/10 px-3 py-1.5 text-sm font-semibold text-neon-300 hover:bg-neon-500/20"
              >
                <FileDown className="h-4 w-4" /> Download PDF
              </button>
            </div>
            {pdfBlocked && (
              <p className="mt-2 text-[11px] text-amber-300/90">
                Your browser blocked the export tab — allow pop-ups for this site, then click Download PDF again.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Published reference points — other customers' results, never inputs */}
      <div className="mt-6 rounded-2xl border border-ink-700 bg-ink-900/60 p-5">
        <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-400">
          published reference points · not a forecast for this account
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {S2_REFERENCES.map((r) => (
            <div key={r.who} className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-neon-400">
                {r.who}
                <BasisTag kind="measured" />
              </p>
              <p className="mt-1 text-sm leading-snug text-ink-300">
                <span className="font-mono font-bold text-neon-300">{r.value}</span> {r.what}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm leading-snug text-ink-300">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-sky-300">
            GigaOm Field Test, Jun 2022 · commissioned by SingleStore
          </span>
          <br />
          ~50% lower 3-yr TCO vs MySQL+Snowflake and ~60% vs PostgreSQL+Redshift stacks, incl. people costs — a
          benchmark, not a customer result.
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
          Measured figures are vendor-published customer claims about other companies&apos; stacks, not independent audits,
          and are never fed into the model. SingleStore cost uses public on-demand list prices ($3.96/credit; S-00 $0.99/h,
          S-1 $3.96/h, S-4 $15.84/h, S-20 $79.20/h; storage $0.023/GB-month; Enterprise ×1.5, Multi-AZ ×1.3;
          singlestore.com/cloud-pricing, accessed 2026-10-14). Committed-use, BYOC and self-managed pricing are not public.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// POC Plan tool — generates a one-workload technical evaluation plan for
// SingleStore and exports a branded PDF
// ---------------------------------------------------------------------------
const FIT_STYLE: Record<string, string> = {
  strong: "bg-neon-500/15 text-neon-300 border-neon-600/40",
  adequate: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  weak: "bg-red-500/15 text-red-300 border-red-500/40",
};
const fitKey = (f: string) =>
  (f || "").toLowerCase().includes("strong")
    ? "strong"
    : /weak|poor/.test((f || "").toLowerCase())
      ? "weak"
      : "adequate";

// Speech-to-text meeting notes routinely garble product names ("click house",
// "my sequel", "post grass"); the model can carry them into the plan. Normalize
// across every string field before rendering/exporting — a safety net behind
// the prompt's canonical-name rule.
const NAME_FIXES: [RegExp, string][] = [
  [/\bsingle ?store\b/gi, "SingleStore"],
  [/\bclick ?house\b/gi, "ClickHouse"],
  [/\bsnow ?flake\b/gi, "Snowflake"],
  [/\bdata ?bricks\b/gi, "Databricks"],
  [/\bmy ?sequel\b/gi, "MySQL"],
  [/\bpost ?gress\b/gi, "PostgreSQL"],
  [/\bpost ?grass\b/gi, "PostgreSQL"],
  [/\bpine ?cone\b/gi, "Pinecone"],
  [/\belastic search\b/gi, "Elasticsearch"],
  [/\bkafta\b/gi, "Kafka"],
];
function fixProductNames<T>(v: T): T {
  if (typeof v === "string") {
    let s: string = v;
    for (const [re, to] of NAME_FIXES) s = s.replace(re, to);
    return s as unknown as T;
  }
  if (Array.isArray(v)) return v.map(fixProductNames) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = fixProductNames(x);
    return out as T;
  }
  return v;
}

function PocTool({ ctx }: { ctx: Ctx }) {
  const [notes, setNotes] = useState("");
  const [plan, setPlan] = useState<PocPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    if (!notes.trim() || loading) return;
    setLoading(true);
    setError("");
    const data = await postAssist({
      mode: "poc",
      notes: notes.trim(),
      tone: ctx.tone,
      persona: ctx.persona,
    }).catch(() => ({ error: "Network error." }));
    setLoading(false);
    if (data.data?.successCriteria) {
      const company = String(data.data.company || "").trim() || "Your prospect";
      setPlan(fixProductNames({ ...data.data, company }) as PocPlan);
      if (data.truncated)
        setError("Heads up: the plan may have been cut off by the token limit — regenerate if a section looks short.");
    } else setError(data.error || "Could not generate the plan.");
  };

  const download = () => {
    if (!plan) return;
    const ok = openPocPdf(plan);
    if (!ok) setError("Your browser blocked the export tab — allow pop-ups for this site, then click Download PDF again.");
  };

  return (
    <div>
      <ToolHeader
        title="POC Plan Generator"
        desc="Dump the full meeting notes or transcript — company, the workload, data volumes, current stack, and pain. It extracts what matters and writes a one-workload technical evaluation plan (scope, success criteria tied to metrics, data and ingest plan, environment, timeline, risks, exit criteria), then exports a branded PDF."
      />

      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={12}
        placeholder="Paste the entire meeting notes or call transcript here — who they are, which workload hurts, the databases, warehouse, cache, search and vector stores behind it, data volume and ingest rate, peak concurrency and latency targets, who the champion and decision-maker are, any security gates or numbers mentioned. The more raw context, the sharper the plan."
        className={notesArea}
      />

      <div className="mt-3 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
        <p className="mb-3 flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-ink-300">
          <Lightbulb className="h-3.5 w-3.5 text-neon-400" /> Questions worth answering in the notes
        </p>
        <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {[
            ["Who's in the room", "“Who's the champion, who signs, and who can veto on security or procurement?”"],
            ["The workload", "“Which one query path or dashboard would you move first, and why that one?”"],
            ["Scale", "“How much data, how fast does it arrive, and how many concurrent users at peak?”"],
            ["Current stack", "“Which databases, warehouse, cache, search and vector stores touch this workload?”"],
            ["Ingest", "“How does the data arrive today — Kafka, S3, CDC from MySQL or Postgres, batch?”"],
            ["The SLA", "“What latency, at what concurrency and freshness, would make this a yes?”"],
            ["The baseline", "“What do those queries take today, and what do those systems cost per month?”"],
            ["Data access", "“Can we test on production-shaped data, masked data, or must it be synthetic?”"],
          ].map(([label, q]) => (
            <li key={label} className="flex gap-2.5">
              <span className="mt-1 font-mono text-[11px] font-bold text-neon-500/80">Q</span>
              <span className="leading-snug">
                <span className="block text-[13px] font-semibold text-ink-200">{label}</span>
                <span className="text-[13px] italic text-ink-400">{q}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3.5 border-t border-ink-700 pt-2.5 text-xs text-ink-500">
          Missing a few is fine — it&apos;ll use bracketed placeholders instead of guessing. Success criteria and the
          cost comparison land hardest when the SLA and a baseline number are in the notes.
        </p>
      </div>

      {error && <div className="mt-3"><Notice text={error} /></div>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <GenerateButton onClick={run} loading={loading} disabled={!notes.trim()} label={plan ? "Regenerate Plan" : "Generate POC Plan"} />
        {plan && (
          <button
            onClick={download}
            className="inline-flex items-center gap-2 rounded-lg border border-neon-600/50 bg-neon-500/15 px-5 py-2.5 text-sm font-semibold text-neon-300 shadow-glow-sm transition-all hover:bg-neon-500/25"
          >
            <FileDown className="h-4 w-4" /> Download PDF
          </button>
        )}
      </div>

      {plan && <PocPreview plan={plan} onChange={setPlan} />}
    </div>
  );
}

// Inline-editable text that blends into the preview (looks like text until you
// hover/focus) and grows to fit. Used to tweak a generated plan before export.
function PocEdit({
  value,
  onChange,
  className = "",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      rows={1}
      className={`w-full resize-none rounded-md border border-transparent bg-transparent px-1.5 py-0.5 transition-colors hover:border-ink-700 focus:border-neon-600/50 focus:bg-ink-950 focus:outline-none ${className}`}
    />
  );
}

function PocSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-3 flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-ink-200">
        <span className="h-3.5 w-1 rounded-full bg-neon-500" /> {title}
      </h4>
      {children}
    </div>
  );
}

// Editable bullet list inside the preview.
function PocList({
  items,
  onChange,
  className = "text-sm text-ink-300",
}: {
  items: string[] | undefined;
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const list = items ?? [];
  return (
    <>
      {list.map((x, i) => (
        <PocEdit
          key={i}
          value={x}
          onChange={(v) => onChange(list.map((y, j) => (j === i ? v : y)))}
          className={className}
        />
      ))}
    </>
  );
}

const FIT_CYCLE = ["strong", "adequate", "weak"] as const;

function PocPreview({ plan, onChange }: { plan: PocPlan; onChange: (p: PocPlan) => void }) {
  const sc = plan.scope ?? { workload: "", inScope: [], outOfScope: [], fit: "", fitNote: "" };
  const fk = fitKey(sc.fit || "");

  const patch = (partial: Partial<PocPlan>) => onChange({ ...plan, ...partial });
  const setScope = (p: Partial<PocPlan["scope"]>) => patch({ scope: { ...sc, ...p } });
  const setData = (p: Partial<PocPlan["dataPlan"]>) => patch({ dataPlan: { ...plan.dataPlan, ...p } });
  const setEnv = (p: Partial<PocPlan["environment"]>) => patch({ environment: { ...plan.environment, ...p } });
  const setRef = (k: "anchor" | "framing" | "yourVersion", v: string) =>
    patch({ reference: { ...plan.reference, [k]: v } });
  const setCriterion = (i: number, k: "criterion" | "target" | "measuredBy", v: string) =>
    patch({ successCriteria: plan.successCriteria.map((s, idx) => (idx === i ? { ...s, [k]: v } : s)) });
  const setMetric = (i: number, k: "name" | "how" | "why", v: string) =>
    patch({ metrics: plan.metrics.map((m, idx) => (idx === i ? { ...m, [k]: v } : m)) });
  // One decision metric: marking one clears the others.
  const togglePrimary = (i: number) =>
    patch({ metrics: plan.metrics.map((m, idx) => ({ ...m, primary: idx === i ? !m.primary : false })) });
  const setPhase = (i: number, k: "phase" | "checkpoint", v: string) =>
    patch({ timeline: plan.timeline.map((t, idx) => (idx === i ? { ...t, [k]: v } : t)) });
  const setActivity = (ti: number, ai: number, v: string) =>
    patch({
      timeline: plan.timeline.map((t, idx) =>
        idx === ti ? { ...t, activities: t.activities.map((a, aj) => (aj === ai ? v : a)) } : t,
      ),
    });
  const setRisk = (i: number, k: "risk" | "mitigation", v: string) =>
    patch({ risks: (plan.risks ?? []).map((r, idx) => (idx === i ? { ...r, [k]: v } : r)) });
  const cycleFit = () => {
    const idx = FIT_CYCLE.indexOf(fk as (typeof FIT_CYCLE)[number]);
    setScope({ fit: FIT_CYCLE[(idx + 1) % FIT_CYCLE.length] });
  };

  const kvRow = (label: string, value: string, onEdit: (v: string) => void) => (
    <div className="flex items-start gap-1.5">
      <span className="mt-1.5 w-14 shrink-0 font-mono text-[9px] font-bold uppercase text-ink-500">{label}</span>
      <PocEdit value={value ?? ""} onChange={onEdit} className="text-xs text-ink-300" />
    </div>
  );

  return (
    <div className="mt-6 space-y-6 rounded-2xl border border-ink-700 bg-ink-900 p-6">
      <div className="border-b border-ink-700 pb-4">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-neon-400">
            SingleStore · Technical Evaluation Plan
          </p>
          <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-ink-500">
            <Pencil className="h-3 w-3" /> click any text to edit
          </span>
        </div>
        <PocEdit value={plan.headline} onChange={(v) => patch({ headline: v })} className="mt-1 text-xl font-bold text-ink-50" />
        <div className="flex items-center px-1.5 text-sm text-ink-400">
          Prepared for
          <PocEdit value={plan.company} onChange={(v) => patch({ company: v })} className="text-sm font-medium text-ink-300" />
        </div>
      </div>

      <PocSection title="Scope & workload fit">
        <div className="rounded-xl border border-ink-700 bg-ink-950 p-4">
          <PocEdit value={sc.workload ?? ""} onChange={(v) => setScope({ workload: v })} className="text-sm font-semibold text-ink-100" />
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="px-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-ink-500">in scope</p>
              <PocList items={sc.inScope} onChange={(v) => setScope({ inScope: v })} className="text-xs text-ink-300" />
            </div>
            <div>
              <p className="px-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-ink-500">out of scope</p>
              <PocList items={sc.outOfScope} onChange={(v) => setScope({ outOfScope: v })} className="text-xs text-ink-300" />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 border-t border-ink-700 pt-3">
            <button
              onClick={cycleFit}
              title="Click to change fit"
              className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase ${FIT_STYLE[fk]}`}
            >
              {fk} fit
            </button>
            <PocEdit value={sc.fitNote ?? ""} onChange={(v) => setScope({ fitNote: v })} className="text-xs text-ink-400" />
          </div>
        </div>
      </PocSection>

      <PocSection title="Success criteria">
        <div className="space-y-2">
          {plan.successCriteria?.map((s, i) => (
            <div key={i} className="flex gap-3 rounded-xl border border-ink-700 bg-ink-950 p-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-neon-500/15 font-mono text-xs font-bold text-neon-300">
                {i + 1}
              </span>
              <div className="flex-1">
                <PocEdit value={s.criterion} onChange={(v) => setCriterion(i, "criterion", v)} className="text-sm font-semibold text-ink-100" />
                <div className="flex items-start gap-1.5">
                  <span className="mt-1.5 shrink-0 font-mono text-[9px] font-bold uppercase text-ink-500">Target</span>
                  <PocEdit value={s.target} onChange={(v) => setCriterion(i, "target", v)} className="text-xs font-semibold text-neon-300" />
                </div>
                <div className="flex items-start gap-1.5">
                  <span className="mt-1.5 shrink-0 font-mono text-[9px] font-bold uppercase text-ink-500">Measured</span>
                  <PocEdit value={s.measuredBy} onChange={(v) => setCriterion(i, "measuredBy", v)} className="text-xs leading-relaxed text-ink-400" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </PocSection>

      <PocSection title="What we'll measure">
        <div className="grid gap-3 sm:grid-cols-2">
          {plan.metrics?.map((m, i) => (
            <div
              key={i}
              className={`relative rounded-xl border p-4 ${m.primary ? "border-neon-600/50 bg-neon-500/5" : "border-ink-700 bg-ink-950"}`}
            >
              <button
                onClick={() => togglePrimary(i)}
                title="Toggle the decision metric"
                className={`absolute -top-2 right-3 rounded-full px-2 py-0.5 font-mono text-[9px] font-bold uppercase ${
                  m.primary ? "bg-neon-500 text-ink-950" : "border border-ink-700 bg-ink-900 text-ink-500"
                }`}
              >
                {m.primary ? "decision metric" : "mark decisive"}
              </button>
              <div className="flex items-start gap-1.5">
                <Gauge className="mt-1.5 h-3.5 w-3.5 shrink-0 text-neon-400" />
                <PocEdit value={m.name} onChange={(v) => setMetric(i, "name", v)} className="text-sm font-semibold text-ink-100" />
              </div>
              <div className="mt-1.5 flex items-start gap-1.5">
                <span className="mt-1.5 shrink-0 font-mono text-[9px] font-bold uppercase text-ink-500">Measured</span>
                <PocEdit value={m.how} onChange={(v) => setMetric(i, "how", v)} className="text-xs text-ink-400" />
              </div>
              <div className="mt-1 flex items-start gap-1.5">
                <span className="mt-1.5 shrink-0 font-mono text-[9px] font-bold uppercase text-ink-500">Why</span>
                <PocEdit value={m.why} onChange={(v) => setMetric(i, "why", v)} className="text-xs text-ink-400" />
              </div>
            </div>
          ))}
        </div>
      </PocSection>

      <PocSection title="Data, ingest & environment">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 rounded-xl border border-ink-700 bg-ink-950 p-3">
            <p className="mb-1 flex items-center gap-1.5 px-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-ink-500">
              <Database className="h-3 w-3 text-neon-400" /> data &amp; ingest
            </p>
            {kvRow("Sources", (plan.dataPlan?.sources ?? []).join(" · "), (v) =>
              setData({ sources: v.split(" · ") }),
            )}
            {kvRow("Ingest", plan.dataPlan?.ingest, (v) => setData({ ingest: v }))}
            {kvRow("Connect", plan.dataPlan?.connectivity, (v) => setData({ connectivity: v }))}
            {kvRow("Volume", plan.dataPlan?.volume, (v) => setData({ volume: v }))}
          </div>
          <div className="space-y-1 rounded-xl border border-ink-700 bg-ink-950 p-3">
            <p className="mb-1 flex items-center gap-1.5 px-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-ink-500">
              <Server className="h-3 w-3 text-neon-400" /> environment
            </p>
            {kvRow("Deploy", plan.environment?.deployment, (v) => setEnv({ deployment: v }))}
            {kvRow("Size", plan.environment?.size, (v) => setEnv({ size: v }))}
            {kvRow("Cost", plan.environment?.costNote, (v) => setEnv({ costNote: v }))}
            {kvRow("Notes", plan.environment?.notes, (v) => setEnv({ notes: v }))}
          </div>
        </div>
      </PocSection>

      <PocSection title="Timeline & checkpoints">
        <div className="grid gap-3 sm:grid-cols-2">
          {plan.timeline?.map((t, i) => (
            <div key={i} className="rounded-xl border border-ink-700 bg-ink-950 p-4">
              <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-neon-300">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <PocEdit value={t.phase} onChange={(v) => setPhase(i, "phase", v)} className="text-sm font-bold text-neon-300" />
              </div>
              <ul className="mb-3 space-y-1">
                {t.activities?.map((a, j) => (
                  <li key={j} className="flex items-start gap-1.5 text-xs text-ink-400">
                    <span className="mt-2 text-ink-600">•</span>
                    <PocEdit value={a} onChange={(v) => setActivity(i, j, v)} className="text-xs text-ink-400" />
                  </li>
                ))}
              </ul>
              <div className="rounded-lg bg-neon-500/10 p-2">
                <span className="block px-1.5 font-mono text-[9px] font-bold uppercase tracking-wide text-neon-400">
                  checkpoint
                </span>
                <PocEdit value={t.checkpoint} onChange={(v) => setPhase(i, "checkpoint", v)} className="text-xs font-medium text-ink-200" />
              </div>
            </div>
          ))}
        </div>
      </PocSection>

      <PocSection title="Risks & mitigations">
        <div className="space-y-2">
          {(plan.risks ?? []).map((r, i) => (
            <div key={i} className="flex gap-3 rounded-xl border border-ink-700 bg-ink-950 p-3">
              <ShieldAlert className="mt-1 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <div className="flex-1">
                <PocEdit value={r.risk} onChange={(v) => setRisk(i, "risk", v)} className="text-sm font-semibold text-ink-100" />
                <PocEdit value={r.mitigation} onChange={(v) => setRisk(i, "mitigation", v)} className="text-xs leading-relaxed text-ink-400" />
              </div>
            </div>
          ))}
        </div>
      </PocSection>

      <PocSection title="Exit criteria">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-neon-600/40 bg-ink-950 p-3">
            <p className="mb-1 flex items-center gap-1.5 px-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-neon-400">
              <Target className="h-3 w-3" /> go
            </p>
            <PocList
              items={plan.exitCriteria?.go}
              onChange={(v) => patch({ exitCriteria: { ...plan.exitCriteria, go: v } })}
            />
          </div>
          <div className="rounded-xl border border-red-500/40 bg-ink-950 p-3">
            <p className="mb-1 px-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-red-400">no-go</p>
            <PocList
              items={plan.exitCriteria?.noGo}
              onChange={(v) => patch({ exitCriteria: { ...plan.exitCriteria, noGo: v } })}
            />
          </div>
        </div>
      </PocSection>

      <PocSection title="Reference point">
        <div className="rounded-xl border border-ink-700 bg-ink-950 p-2">
          <PocEdit value={plan.reference?.anchor ?? ""} onChange={(v) => setRef("anchor", v)} className="text-sm font-medium leading-relaxed text-ink-100" />
          <PocEdit value={plan.reference?.framing ?? ""} onChange={(v) => setRef("framing", v)} placeholder="(optional framing line)" className="mt-1 text-sm text-ink-400" />
          <div className="mt-2 border-t border-ink-700 pt-2">
            <PocEdit value={plan.reference?.yourVersion ?? ""} onChange={(v) => setRef("yourVersion", v)} className="text-sm text-ink-400" />
          </div>
        </div>
      </PocSection>

      <PocSection title="Roles, checklist & next steps">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-ink-700 bg-ink-950 p-3">
            <p className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-ink-500">roles &amp; ownership</p>
            <PocList
              items={plan.roles?.customer}
              onChange={(v) => patch({ roles: { ...plan.roles, customer: v } })}
            />
            <PocList
              items={plan.roles?.singlestore}
              onChange={(v) => patch({ roles: { ...plan.roles, singlestore: v } })}
            />
          </div>
          <div className="rounded-xl border border-ink-700 bg-ink-950 p-3">
            <p className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-ink-500">pre-evaluation checklist</p>
            <PocList items={plan.checklist} onChange={(v) => patch({ checklist: v })} />
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-ink-700 bg-ink-950 p-3">
          <p className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wide text-ink-500">next steps</p>
          <PocList items={plan.nextSteps} onChange={(v) => patch({ nextSteps: v })} />
        </div>
      </PocSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls (mode pills + tone/persona) + main
// ---------------------------------------------------------------------------
function Controls({
  mode,
  setMode,
  tone,
  setTone,
  persona,
  setPersona,
}: {
  mode: string;
  setMode: (m: string) => void;
  tone: string;
  setTone: (v: string) => void;
  persona: string;
  setPersona: (v: string) => void;
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {MODES.map((m) => {
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-xs font-medium transition-all ${
                active
                  ? "border-neon-600/50 bg-neon-500/10 text-neon-300"
                  : "border-ink-700 bg-ink-900 text-ink-400 hover:border-ink-600 hover:text-ink-200"
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: m.dot }} />
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-5">
        <Dropdown label="tone" value={tone} onChange={setTone} options={TONES} />
        <Dropdown label="selling to" value={persona} onChange={setPersona} options={PERSONAS} />
      </div>
    </div>
  );
}

function Dropdown({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm font-medium text-ink-200 focus:border-neon-600/50 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SalesAssist({ initialMode }: { initialMode?: string } = {}) {
  // initialMode: deep links (Pipeline Questions → MEDDPICC / POC Plan) land
  // on the right tool. Applies on mount only — the component unmounts when
  // the tab switches away, so each arrival re-reads it.
  const [mode, setMode] = useState(initialMode ?? "ask");
  const [tone, setTone] = useState("Direct");
  const [persona, setPersona] = useState(PERSONAS[0]);
  const ctx: Ctx = { tone, persona };

  return (
    <div className="space-y-6">
      <Controls mode={mode} setMode={setMode} tone={tone} setTone={setTone} persona={persona} setPersona={setPersona} />

      <div className="border-t border-ink-700 pt-6">
        {/* key=mode resets each tool's internal state when switching modes */}
        {CHAT_MODES.has(mode) ? (
          <ChatTool key="chat" ctx={ctx} />
        ) : mode === "lou" ? (
          <LouTool key="lou" ctx={ctx} />
        ) : mode === "threading" ? (
          <ThreadingTool key="threading" ctx={ctx} />
        ) : mode === "poc" ? (
          <PocTool key="poc" ctx={ctx} />
        ) : mode === "roi" ? (
          <RoiTool key="roi" />
        ) : (
          <MeddpiccTool key="meddpicc" ctx={ctx} />
        )}
      </div>
    </div>
  );
}
