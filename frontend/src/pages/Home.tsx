import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Crosshair,
  Database,
  GraduationCap,
  Sparkles,
  Video,
} from "lucide-react";
import { useRobots } from "@/hooks/useRobots";
import { useDatasets } from "@/hooks/useDatasets";
import { useApi } from "@/contexts/ApiContext";
import { JobRecord, listJobs } from "@/lib/jobsApi";
import UsageInstructionsModal from "@/components/landing/UsageInstructionsModal";
import { isHostedSpace } from "@/lib/isHostedSpace";

const isSkill = (j: JobRecord) => j.checkpoint_count > 0 || j.runner === "imported";
const ON_SPACE = isHostedSpace();

const Home: React.FC = () => {
  const navigate = useNavigate();
  const { selectedRecord } = useRobots();
  const [showUsage, setShowUsage] = useState(ON_SPACE);
  const { datasets } = useDatasets();
  const { baseUrl, fetchWithHeaders } = useApi();

  const [jobs, setJobs] = useState<JobRecord[]>([]);
  useEffect(() => {
    let cancelled = false;
    listJobs(baseUrl, fetchWithHeaders, 200)
      .then((j) => !cancelled && setJobs(j))
      .catch(() => !cancelled && setJobs([]));
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchWithHeaders]);

  const robotReady = !!selectedRecord?.is_clean;
  const recordings = datasets.filter((d) => d.source === "local" || d.source === "both").length;
  const skills = jobs.filter(isSkill).length;
  const running = jobs.filter((j) => j.state === "running").length;

  const steps = [
    {
      n: 1,
      name: "Set up your robot",
      desc: "Plug in the leader and follower arms, then calibrate so the robot learns how far each joint can move.",
      term: "Calibration",
      to: "/robot",
      cta: "Set up robot",
      Icon: Crosshair,
      done: robotReady,
    },
    {
      n: 2,
      name: "Show it a task",
      desc: "Guide the arm through the task by hand a few times. LeLab records each run as an episode.",
      term: "Teleoperation",
      to: "/datasets",
      cta: "Record a task",
      Icon: Video,
      done: recordings > 0,
    },
    {
      n: 3,
      name: "Train a skill",
      desc: "Turn your recordings into a skill the robot can repeat on its own.",
      term: "Policy · checkpoint",
      to: "/training",
      cta: "Train",
      Icon: GraduationCap,
      done: skills > 0,
    },
    {
      n: 4,
      name: "Run the skill",
      desc: "Pick a learned skill and let the robot do the task hands-free.",
      term: "Inference",
      to: "/skills",
      cta: "Run a skill",
      Icon: Sparkles,
      done: false,
    },
  ];
  const nextIndex = steps.findIndex((s) => !s.done);
  const next = steps[nextIndex] ?? steps[steps.length - 1];

  const stats = [
    { label: "Skills learned", value: skills, to: "/skills", Icon: Sparkles },
    { label: "Recordings", value: recordings, to: "/datasets", Icon: Database },
    { label: "Training now", value: running, to: "/training", Icon: GraduationCap },
  ];

  return (
    <>
      <div className="page page-stack" style={{ gap: "2.5rem" }}>
      <section className="pt-4">
        <div className="eyebrow eyebrow-amber">
          <Bot className="h-3.5 w-3.5" />
          Local robot teaching · SO-101
        </div>
        <h1 className="hero-title mt-4">
          Teach your robot
          <br />
          new <em>skills</em>.
        </h1>
        <p className="hero-lede">
          Guide your SO-101 arm through a task by hand, train it on what you
          showed, then watch it do the job on its own. Every step runs on your
          computer — no cloud required.
        </p>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <button className="btn-armed px-5 py-2.5" onClick={() => navigate(next.to)}>
            {robotReady || nextIndex > 0 ? `Continue: ${next.name}` : "Start here"}
            <ArrowRight className="h-4 w-4" />
          </button>
          <div className="pill">
            {robotReady ? (
              <>
                <span className="dot dot-live" />
                {selectedRecord?.name} ready
              </>
            ) : selectedRecord ? (
              <>
                <span className="dot dot-amber" />
                {selectedRecord.name} needs setup
              </>
            ) : (
              <>
                <span className="dot dot-idle" />
                No robot yet
              </>
            )}
          </div>
        </div>
      </section>

      <section className="page-stack" style={{ gap: "1rem" }}>
        <div className="flex items-baseline justify-between">
          <span className="eyebrow">How it works</span>
          <span className="font-mono text-xs uppercase tracking-wider text-[var(--ink-faint)]">
            four steps
          </span>
        </div>
        <div className="journey">
          {steps.map((s, i) => {
            const state = s.done ? "done" : i === nextIndex ? "next" : "todo";
            return (
              <Link key={s.n} to={s.to} className="step-card" data-state={state}>
                <div className="flex items-center justify-between">
                  <span className="step-index">{s.done ? <CheckCircle2 className="h-4 w-4" /> : s.n}</span>
                  {state === "next" && (
                    <span className="pill pill-amber">Next</span>
                  )}
                  {state === "done" && (
                    <span className="font-mono text-[0.65rem] uppercase tracking-wider text-[#9bf0c4]">
                      Done
                    </span>
                  )}
                </div>
                <div className="step-name">{s.name}</div>
                <p className="step-desc">{s.desc}</p>
                <div className="mt-auto flex items-center justify-between pt-2">
                  <span className="term">
                    called <b>{s.term}</b>
                  </span>
                  <s.Icon className="h-4 w-4 text-[var(--ink-faint)]" />
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="stat-grid">
        {stats.map(({ label, value, to, Icon }) => (
          <Link key={label} to={to} className="stat-card">
            <span className="grid h-11 w-11 flex-none place-items-center rounded-lg border border-border bg-[var(--surface-2)] text-primary">
              <Icon className="h-5 w-5" />
            </span>
            <div>
              <div className="stat-num">{value}</div>
              <div className="text-sm text-muted-foreground">{label}</div>
            </div>
          </Link>
        ))}
      </section>
      </div>

      <UsageInstructionsModal
        open={showUsage}
        onOpenChange={setShowUsage}
        dismissible={!ON_SPACE}
      />
    </>
  );
};

export default Home;
