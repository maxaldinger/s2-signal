"use client";

// Pipeline Questions — static reference for live calls. Two columns: the
// discovery call on the left, the POC scoping call on the right. Structure and
// order are Max's (2026-08-14), re-aimed at SingleStore deals; questions only — he cut the explanatory notes on
// purpose, so don't add commentary back.

import { ArrowUpRight, ClipboardList, Compass, FlaskConical } from "lucide-react";

interface Q {
  n: number;
  q: string;
}

interface Group {
  heading: string;
  items: Q[];
}

const DISCOVERY: Group[] = [
  {
    heading: "Scale and shape",
    items: [
      {
        n: 1,
        q: "What sits behind this product today: which databases, warehouse, cache, search and vector stores, and what moves data between them?",
      },
      {
        n: 2,
        q: "How much data, how fast does it arrive, and how many users or services query it at peak?",
      },
      {
        n: 3,
        q: "When a new feature needs fresh data in front of a customer, who builds the pipeline and how long does that take?",
      },
    ],
  },
  {
    heading: "Current state",
    items: [
      {
        n: 4,
        q: "Which system serves the customer-facing or operational queries today, and was it built for that job?",
      },
      {
        n: 5,
        q: "What do you spend per month across those systems and the pipelines between them, and who owns that bill?",
      },
      {
        n: 6,
        q: "What have you already tried: read replicas, caching, pre-aggregation, another store?",
      },
    ],
  },
  {
    heading: "The pain, in their words",
    items: [
      // Broadest first — "what breaks first" opens the wound, freshness drills
      // into the sharpest instance, and cost lands last so it prices the pain
      // they just described.
      { n: 7, q: "Which query or dashboard is slowest, or breaks first under load?" },
      {
        n: 8,
        q: "How stale is the data by the time someone queries it, and what does that cost the product?",
      },
      {
        n: 9,
        q: "What is the cost of that today, in engineering time, incidents or lost deals, not in compute?",
      },
    ],
  },
  {
    heading: "Priority",
    items: [
      // Scope is the GATE, so it goes first: if the warehouse and the whole
      // stack are being re-platformed, the one-workload pitch lands differently.
      {
        n: 10,
        q: "Is this about fixing one painful workload now, or consolidating systems over the next year?",
      },
      {
        n: 11,
        q: "If you could only fix one, speed and freshness or cost, which one and why?",
      },
    ],
  },
  {
    heading: "The one nobody asks",
    items: [
      // Deliberately BEFORE the buying-process block, not dead last: asked as
      // an interrogation coda it lands flat, asked here it defuses the old
      // objection while there's still call time to address it.
      {
        n: 12,
        q: "What happened the last time you evaluated a new database and didn't move to it?",
      },
    ],
  },
  {
    heading: "Buying process",
    items: [
      { n: 13, q: "Who owns this decision, and who has to approve it?" },
      {
        n: 14,
        q: "Has a new data store gone through security review and procurement before, and who runs that?",
      },
      {
        n: 15,
        q: "Is there budget for this, or does it come out of existing database and warehouse spend?",
      },
      // The closer — it tees the POC scoping call as the natural next step.
      { n: 16, q: "What would have to be true for you to move forward after a POC?" },
    ],
  },
];

const POC: Group[] = [
  {
    heading: "Success definition, first, before anything else",
    items: [
      {
        n: 1,
        q: "Which query, at what concurrency and freshness, has to hit what number for this to be a yes?",
      },
      { n: 2, q: "Who inside your organization has to see that number to approve a purchase?" },
      {
        n: 3,
        q: "What does failure look like?",
      },
    ],
  },
  {
    heading: "Baseline",
    items: [
      {
        n: 4,
        q: "What is that number on the current system today? If nobody knows, who can measure it, and by when?",
      },
      {
        n: 5,
        q: "Do you have the real query set, query logs and peak concurrency, or only averages?",
      },
      {
        n: 6,
        q: "Can we test with production-sized data, the same queries and the same concurrency, so the only variable is the engine?",
      },
    ],
  },
  {
    heading: "Scope",
    items: [
      {
        n: 7,
        q: "Which one workload, and which tables and sources feed it?",
      },
      {
        n: 8,
        q: "Can we use production data, masked data, or does it have to be synthetic, and how much of it?",
      },
      {
        n: 9,
        q: "How does the data arrive today: Kafka, S3, CDC from MySQL or Postgres, batch jobs?",
      },
    ],
  },
  {
    heading: "Ownership and timeline",
    items: [
      { n: 10, q: "Who is driving this day to day on your side?" },
      { n: 11, q: "How much time can they realistically give it per week?" },
      {
        n: 12,
        q: "What is the start date and the end date?",
      },
      { n: 13, q: "When does the readout happen, and who is in the room?" },
    ],
  },
  {
    heading: "Deployment and blockers",
    items: [
      {
        n: 14,
        q: "Helios in our cloud, Helios in your own cloud account (BYOC), or self-managed, and who decides?",
      },
      { n: 15, q: "Who owns InfoSec approval and what's their typical turnaround?" },
      {
        n: 16,
        q: "What access do we need — a sample dataset, a Kafka topic or S3 bucket, network paths from your apps and BI tools — and who grants it?",
      },
      { n: 17, q: "What could stop this from starting on time?" },
    ],
  },
  {
    heading: "After",
    items: [
      {
        n: 18,
        q: "If the POC hits the number, what is the next step, and is there a budget cycle it has to fit?",
      },
      { n: 19, q: "Who else needs to be convinced besides the people on this call?" },
    ],
  },
];

function QuestionList({ groups }: { groups: Group[] }) {
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.heading}>
          <h4 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">
            {g.heading}
          </h4>
          <ol className="space-y-2.5">
            {g.items.map((item) => (
              <li key={item.n} className="flex gap-2.5">
                <span className="mt-px w-5 shrink-0 text-right font-mono text-[11px] font-semibold text-neon-400">
                  {item.n}
                </span>
                <p className="min-w-0 text-sm leading-snug text-ink-100">{item.q}</p>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

export function PipelineQuestions({
  onOpenAssist,
}: {
  /** Jump to a Sales Assist tool — "meddpicc" after discovery, "poc" after scoping. */
  onOpenAssist: (mode: "meddpicc" | "poc") => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight text-ink-50">
          <ClipboardList className="h-5 w-5 text-neon-400" /> Pipeline Questions
        </h2>
        <p className="mt-1 text-sm text-ink-400">
          The two call scripts that move a deal: discovery on the left, POC scoping on the right.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-ink-700 bg-ink-900/60 p-5">
          <h3 className="mb-4 flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-sky-300">
            <Compass className="h-4 w-4" /> Discovery call
          </h3>
          <QuestionList groups={DISCOVERY} />
          <button
            type="button"
            onClick={() => onOpenAssist("meddpicc")}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-sky-300 transition-colors hover:bg-sky-500/20"
          >
            Score the call · MEDDPICC scorecard <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </section>

        <section className="rounded-xl border border-ink-700 bg-ink-900/60 p-5">
          <h3 className="mb-4 flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-violet-300">
            <FlaskConical className="h-4 w-4" /> POC scoping call
          </h3>
          <QuestionList groups={POC} />
          <button
            type="button"
            onClick={() => onOpenAssist("poc")}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-violet-300 transition-colors hover:bg-violet-500/20"
          >
            Build the plan · POC Plan generator <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </section>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <p className="text-sm leading-relaxed text-amber-200/90">
          The two most important on the whole list are <strong>POC #1</strong> and{" "}
          <strong>POC #12</strong>. An evaluation without an agreed number and an end date drifts
          into an open-ended trial — a stalled deal is almost always missing one or both.
        </p>
      </div>
    </div>
  );
}
