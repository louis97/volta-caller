"use client";

import "./landing.css";

import { useRef, type CSSProperties } from "react";
import { motion, useScroll, useTransform } from "motion/react";

const LANES = [
  "Bogotá · Buenaventura",
  "Medellín · Cartagena",
  "Cali · Barranquilla",
  "Bucaramanga · Santa Marta",
  "Pereira · Buenaventura",
  "Cúcuta · Bogotá"
];

const STAGES = [
  {
    n: "01",
    title: "Mandate open",
    note: "You set the cargo, the route, the pickup window and a budget ceiling. That ceiling is binding — Volta cannot spend past it.",
    seed: "warehousepallets",
    tone: ""
  },
  {
    n: "02",
    title: "Calling carriers",
    note: "Volta dials the pool in parallel and holds real conversations. Every line is recorded, transcribed and attributed to a speaker.",
    seed: "phoneswitchboard",
    tone: "lp-stage--signal"
  },
  {
    n: "03",
    title: "Quotes in",
    note: "Terms come back as structured records, not notes. Price, transit time and equipment sit side by side, comparable.",
    seed: "papermanifest",
    tone: ""
  },
  {
    n: "04",
    title: "Waiting on you",
    note: "Volta proposes one carrier and shows its reasoning with citations back to the call. Nothing executes until you approve.",
    seed: "handssigning",
    tone: "lp-stage--brass"
  },
  {
    n: "05",
    title: "Closing call",
    note: "On approval Volta calls back to confirm the terms out loud. A proposal that went stale expires instead of booking old terms.",
    seed: "truckcabinterior",
    tone: "lp-stage--signal"
  },
  {
    n: "06",
    title: "Booked",
    note: "The load is committed and the audit record is closed: who decided, on what evidence, at what price, at what minute.",
    seed: "containeryardsunset",
    tone: "lp-stage--commit"
  }
];

const BIG_FIGURE = { "--fs": "46px" } as CSSProperties;

const REVEAL =
  "An agent that can spend your money without asking is not an assistant. It is a liability. Volta works the phones for hours and still hands you the one decision that costs something.";

function ScrubbedReveal() {
  const ref = useRef<HTMLParagraphElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.85", "end 0.45"]
  });
  const words = REVEAL.split(" ");

  return (
    <p className="lp-reveal" ref={ref}>
      {words.map((word, i) => (
        <RevealWord
          key={`${word}-${i}`}
          word={word}
          progress={scrollYProgress}
          start={i / words.length}
          end={(i + 1) / words.length}
        />
      ))}
    </p>
  );
}

function RevealWord({
  word,
  progress,
  start,
  end
}: {
  word: string;
  progress: ReturnType<typeof useScroll>["scrollYProgress"];
  start: number;
  end: number;
}) {
  const opacity = useTransform(progress, [start, end], [0.12, 1]);
  return <motion.span style={{ opacity }}>{`${word} `}</motion.span>;
}

function ProofPanel() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"]
  });
  const scale = useTransform(scrollYProgress, [0, 0.45, 1], [0.88, 1, 1]);
  const opacity = useTransform(
    scrollYProgress,
    [0, 0.3, 0.8, 1],
    [0.25, 1, 1, 0.3]
  );

  return (
    <motion.div className="lp-proof" ref={ref} style={{ scale, opacity }}>
      <div className="lp-proof__media" />
      <div className="lp-proof__quote">
        <blockquote>
          It calls forty carriers by lunch. I read six lines and sign one.
        </blockquote>
        <div className="lp-proof__who">
          <div className="lp-proof__face" />
          <div>
            <div style={{ fontWeight: 500 }}>Dispatch lead</div>
            <div className="lp-micro">Freight forwarder · Bogotá</div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export default function Landing() {
  return (
    <main className="lp">
      <nav className="lp-nav">
        <a className="lp-nav__brand" href="#top">
          <span className="lp-nav__mark" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path
                d="M3 2v7a5 5 0 0 0 10 0V2"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          Volta
        </a>
        <div className="lp-nav__links">
          <a href="#how">How it runs</a>
          <a href="#record">The record</a>
        </div>
        <a className="lp-btn lp-btn--solid lp-btn--sm" href="/">
          Open the console
        </a>
      </nav>

      <header className="lp-hero" id="top">
        <div className="lp-hero__bed" />
        <div className="lp-hero__wash" />
        <div className="lp-hero__grain" />
        <div className="lp-shell lp-hero__inner">
          <h1>
            Volta works the
            <span className="lp-inline-pill" aria-hidden="true" />
            phones. You only sign the deal.
          </h1>
          <p className="lp-hero__lede">
            An autonomous dispatcher that calls every carrier on your lane,
            negotiates in real conversation, and brings back one recommendation
            you can approve or decline in a single click.
          </p>
          <div className="lp-hero__cta">
            <a className="lp-btn lp-btn--solid" href="/">
              Open the console
            </a>
            <a className="lp-btn lp-btn--ghost" href="#how">
              Watch a mandate run
            </a>
          </div>
        </div>
      </header>

      <div className="lp-marquee">
        <div className="lp-marquee__track">
          {[...LANES, ...LANES].map((lane, i) => (
            <span className="lp-marquee__item" key={`${lane}-${i}`}>
              <i aria-hidden="true" />
              {lane}
            </span>
          ))}
        </div>
      </div>

      <section className="lp-section" id="record">
        <div className="lp-shell">
          <div className="lp-section__head">
            <h2>Every number on this page traces back to a recorded call.</h2>
            <p>
              Volta does not summarise. It cites. Each quote, each commitment
              and each refusal resolves to the second of the conversation it
              came from.
            </p>
          </div>

          <div className="lp-bento">
            <article className="lp-cell lp-cell--tall">
              <div className="lp-cell__media" />
              <div className="lp-cell__scrim" />
              <div className="lp-cell__body">
                <h3>The call floor, without the floor.</h3>
                <p>
                  Parallel outbound lines held by one agent. Speaker-attributed
                  transcripts land in the console while the call is still open,
                  so you watch a negotiation instead of reading about it later.
                </p>
              </div>
            </article>

            <article className="lp-cell lp-cell--wide">
              <div className="lp-cell__body">
                <h3>Proposals, never executions.</h3>
                <p>
                  The agent can read your whole book but can only write a
                  proposal. Carrier selection and closing calls persist as
                  pending decisions until a human resolves them.
                </p>
              </div>
            </article>

            <article className="lp-cell lp-cell--brass">
              <div className="lp-cell__stat">
                <span className="lp-figure" style={BIG_FIGURE}>
                  1
                </span>
                <h3>Decision per load</h3>
                <p>Approve or decline. That is the whole human surface.</p>
              </div>
            </article>

            <article className="lp-cell lp-cell--commit">
              <div className="lp-cell__stat">
                <span className="lp-figure" style={BIG_FIGURE}>
                  1825
                </span>
                <h3>Days of audit</h3>
                <p>Who decided, on what evidence, at what price.</p>
              </div>
            </article>

            <article className="lp-cell lp-cell--band lp-cell--signal">
              <div className="lp-cell__body">
                <h3>A stale approval expires. It does not book.</h3>
                <p>
                  Before execution, an approved proposal is revalidated against
                  the current operation version. If the terms moved while you
                  were away, Volta stops and asks again.
                </p>
              </div>
              <a className="lp-btn lp-btn--ghost" href="#how">
                See the pipeline
              </a>
            </article>
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-shell">
          <ScrubbedReveal />
        </div>
      </section>

      <section className="lp-section" id="how">
        <div className="lp-shell">
          <div className="lp-section__head">
            <h2>Six stages from open mandate to booked load.</h2>
            <p>
              The console shows exactly this pipeline. Hover any stage to see
              what Volta is allowed to do inside it.
            </p>
          </div>
          <div className="lp-stages">
            {STAGES.map((stage) => (
              <button
                type="button"
                className={`lp-stage ${stage.tone}`}
                key={stage.n}
              >
                <div
                  className="lp-stage__media"
                  style={{
                    backgroundImage: `url(https://picsum.photos/seed/${stage.seed}/1000/1400)`
                  }}
                />
                <div className="lp-stage__scrim" />
                <div className="lp-stage__body">
                  <span className="lp-stage__index">{stage.n}</span>
                  <span className="lp-stage__title">{stage.title}</span>
                  <span className="lp-stage__note">{stage.note}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-shell">
          <ProofPanel />
        </div>
      </section>

      <section className="lp-close">
        <div className="lp-close__glow" />
        <div className="lp-shell lp-close__inner">
          <h2>Give it the lane tonight. Read the quotes in the morning.</h2>
          <p>
            Volta runs the mandate while the floor is closed and leaves one
            decision waiting for you.
          </p>
          <div className="lp-hero__cta">
            <a className="lp-btn lp-btn--solid" href="/">
              Open the console
            </a>
            <a className="lp-btn lp-btn--ghost" href="#top">
              Back to the top
            </a>
          </div>
        </div>
      </section>

      <footer className="lp-foot">
        <div className="lp-shell lp-foot__inner">
          <span>Volta Dispatch</span>
          <div className="lp-foot__links">
            <a href="#how">How it runs</a>
            <a href="#record">The record</a>
            <a href="/">Console</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
