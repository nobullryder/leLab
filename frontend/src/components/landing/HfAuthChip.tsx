import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { useHfAuth } from "@/contexts/HfAuthContext";
import HfAuthDialog from "./HfAuthDialog";

const HfAuthChip: React.FC = () => {
  const { auth } = useHfAuth();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (auth.status === "loading") {
    return (
      <div className="pill">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>HF</span>
      </div>
    );
  }

  if (auth.status === "authenticated") {
    return (
      <div className="pill pill-live" title={`Hugging Face: ${auth.username}`}>
        <span className="dot dot-live" aria-hidden="true" />
        <span className="max-w-[10rem] truncate normal-case">{auth.username}</span>
      </div>
    );
  }

  // unauthenticated
  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="pill pill-amber transition-colors hover:brightness-110"
        aria-label="Hugging Face not configured — show login instructions"
      >
        <span className="dot dot-amber" aria-hidden="true" />
        <span>HF not set</span>
      </button>
      <HfAuthDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
};

export default HfAuthChip;
