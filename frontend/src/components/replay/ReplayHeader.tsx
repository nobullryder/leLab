import React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import Logo from "@/components/Logo";

interface Props {
  repoId: string | null;
  episode: number | null;
}

const ReplayHeader: React.FC<Props> = ({ repoId, episode }) => {
  const detail =
    repoId && episode !== null
      ? `${repoId} • ep ${episode}`
      : "No episode selected";

  const navigate = useNavigate();

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-4 text-3xl">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/")}
          className="text-slate-400 hover:bg-slate-800 hover:text-white rounded-lg"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <Logo />
        <h1 className="font-bold text-white text-2xl">Replay Dataset</h1>
      </div>
      <span className="font-mono text-sm text-gray-400 truncate max-w-md">
        {detail}
      </span>
    </div>
  );
};

export default ReplayHeader;
