import React from "react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import UrdfViewer from "../UrdfViewer";
import Logo from "@/components/Logo";

interface VisualizerPanelProps {
  onGoBack: () => void;
  className?: string;
}

const VisualizerPanel: React.FC<VisualizerPanelProps> = ({
  onGoBack,
  className,
}) => {
  return (
    <div className={cn("flex h-full w-full flex-col", className)}>
      <div className="plate flex min-h-0 flex-1 flex-col p-3 sm:p-4">
        <div className="mb-3 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={onGoBack}
            aria-label="Stop teleoperation and go back"
            className="flex-shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <Logo iconOnly />
          <div className="h-7 w-px bg-border" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
                Teleoperation
              </h2>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              Move the leader arm — the follower mirrors it. Stop before
              switching workflows.
            </p>
          </div>

          <div className="ml-auto hidden items-center gap-2 font-mono text-xs uppercase tracking-wider sm:flex">
            <span className="text-[var(--ink-soft)]">Leader</span>
            <ArrowRight className="h-3.5 w-3.5 text-primary" />
            <span className="text-[var(--ink-soft)]">Follower</span>
          </div>
        </div>

        <div className="ticked relative min-h-0 flex-1 overflow-hidden rounded-[calc(var(--radius)-3px)] border border-border bg-[var(--sunken)]">
          <UrdfViewer />
        </div>
      </div>
    </div>
  );
};

export default VisualizerPanel;
