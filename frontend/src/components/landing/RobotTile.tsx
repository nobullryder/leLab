import React, { useState } from "react";
import { Settings, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RobotRecord } from "@/hooks/useRobots";
import RobotSelector from "./RobotSelector";

interface RobotTileProps {
  robot: RobotRecord | null;
  selectedName: string | null;
  availableNames: string[];
  isLoading: boolean;
  onSelect: (name: string) => void;
  onCreateNew: (name: string) => Promise<boolean>;
  onConfigure: (name: string) => void;
  onTeleop: (robot: RobotRecord) => void;
  onDelete: (name: string) => void;
}

const RobotTile: React.FC<RobotTileProps> = ({
  robot,
  selectedName,
  availableNames,
  isLoading,
  onSelect,
  onCreateNew,
  onConfigure,
  onTeleop,
  onDelete,
}) => {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = robot ? (robot.is_clean ? "Ready" : "Needs configuration") : null;
  const teleopDisabled = !robot || !robot.is_clean;

  return (
    <div className="relative flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <RobotSelector
            selectedName={selectedName}
            availableNames={availableNames}
            onSelect={onSelect}
            onCreateNew={onCreateNew}
            isLoading={isLoading}
          />
        </div>
        {status && (
          <span
            className={`shrink-0 truncate font-mono text-[0.68rem] font-semibold uppercase tracking-wider ${
              robot!.is_clean ? "text-[#9bf0c4]" : "text-[var(--amber-bright)]"
            }`}
          >
            {status}
          </span>
        )}
        {robot && (
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 hover:text-primary"
                  onClick={() => onConfigure(robot.name)}
                  aria-label="Configure"
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Configure (calibrate)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-[var(--red)] hover:bg-[var(--red-soft)] hover:text-[#ffb0ab]"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete robot"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete robot config</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {robot && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="w-full">
              <Button
                onClick={() => onTeleop(robot)}
                disabled={teleopDisabled}
                className="w-full"
              >
                Start teleoperation
              </Button>
            </div>
          </TooltipTrigger>
          {teleopDisabled && (
            <TooltipContent>Configure the robot first.</TooltipContent>
          )}
        </Tooltip>
      )}

      {robot && (
        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete robot config?</DialogTitle>
              <DialogDescription>
                This deletes the robot config file from disk. Calibration files
                are not removed. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  setConfirmDelete(false);
                  await onDelete(robot.name);
                }}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};

export default RobotTile;
