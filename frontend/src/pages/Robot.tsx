import React from "react";
import { useNavigate } from "react-router-dom";
import { Bot, CheckCircle2, Circle, Crosshair, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import RobotConfigManager from "@/components/landing/RobotConfigManager";
import { useRobots } from "@/hooks/useRobots";

const Robot: React.FC = () => {
  const navigate = useNavigate();
  const {
    selectedName,
    selectedRecord,
    availableNames,
    isLoading,
    selectRobot,
    createRobot,
    deleteRobot,
  } = useRobots();

  const calibrate = () => {
    if (!selectedRecord) return;
    navigate("/calibration", { state: { robot_name: selectedRecord.name } });
  };

  const leaderDone = !!selectedRecord?.leader_config;
  const followerDone = !!selectedRecord?.follower_config;

  return (
    <div className="page page-stack">
      <header className="page-head">
        <div>
          <div className="eyebrow eyebrow-amber">
            <Bot className="h-3.5 w-3.5" />
            Your robot
          </div>
          <h1 className="page-title mt-2.5">Set up your robot</h1>
          <p className="page-subtitle">
            Pick or create a robot, point LeLab at the right ports, and calibrate
            both arms so the robot knows its limits before it moves.
          </p>
        </div>
        <div className="lab-trust-chip">
          <ShieldCheck className="h-4 w-4 text-primary" />
          Runs on this machine
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="plate plate-pad-lg">
          <div className="mb-4 flex items-center justify-between gap-3">
            <span className="eyebrow">Robot</span>
            <span className="term">
              two arms, <b>leader → follower</b>
            </span>
          </div>
          <RobotConfigManager
            selectedName={selectedName}
            selectedRecord={selectedRecord}
            availableNames={availableNames}
            isLoading={isLoading}
            selectRobot={selectRobot}
            createRobot={createRobot}
            deleteRobot={deleteRobot}
          />
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            You move the <span className="text-foreground">leader</span> arm by
            hand; the <span className="text-foreground">follower</span> arm copies
            it. That mirroring is called{" "}
            <span className="font-mono text-xs uppercase tracking-wider text-[var(--amber-bright)]">
              teleoperation
            </span>
            . Use “Start teleoperation” above to test that both arms move
            together.
          </p>
        </div>

        <aside className="plate plate-pad ticked">
          <span className="eyebrow">Readiness</span>
          <div className="mt-4 space-y-4">
            <div>
              <p className="readout-label">Selected robot</p>
              <p className="mt-1.5 truncate font-display text-2xl font-semibold tracking-tight text-foreground">
                {selectedRecord?.name ?? "None selected"}
              </p>
            </div>

            <div className="readout-grid">
              <div className="readout-cell">
                <p className="readout-label">Leader port</p>
                <p className="readout-value readout-value-sm mt-1.5 truncate">
                  {selectedRecord?.leader_port || "—"}
                </p>
              </div>
              <div className="readout-cell">
                <p className="readout-label">Follower port</p>
                <p className="readout-value readout-value-sm mt-1.5 truncate">
                  {selectedRecord?.follower_port || "—"}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <p className="field-label">Calibration</p>
              {[
                { label: "Leader arm", done: leaderDone },
                { label: "Follower arm", done: followerDone },
              ].map((row) => (
                <div key={row.label} className="flex items-center gap-2 text-sm">
                  {row.done ? (
                    <CheckCircle2 className="h-4 w-4 text-[var(--green)]" />
                  ) : (
                    <Circle className="h-4 w-4 text-[var(--ink-faint)]" />
                  )}
                  <span className={row.done ? "text-foreground" : "text-muted-foreground"}>
                    {row.label}
                  </span>
                  <span className="ml-auto font-mono text-[0.65rem] uppercase tracking-wider text-[var(--ink-faint)]">
                    {row.done ? "ready" : "not set"}
                  </span>
                </div>
              ))}
            </div>

            <Button
              onClick={calibrate}
              disabled={!selectedRecord}
              className="w-full"
            >
              <Crosshair className="mr-2 h-4 w-4" />
              {leaderDone && followerDone ? "Re-calibrate" : "Calibrate now"}
            </Button>

            <div className={selectedRecord?.is_clean ? "signal signal-ready" : "signal signal-warn"}>
              {selectedRecord?.is_clean ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <Crosshair className="h-4 w-4" />
              )}
              <span>
                {selectedRecord?.is_clean
                  ? "This robot is ready to record, train, and run skills."
                  : "Calibration teaches the arm how far each joint can move — finish it before recording."}
              </span>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
};

export default Robot;
