import React from "react";
import { cn } from "@/lib/utils";

interface LogoProps extends React.HTMLAttributes<HTMLDivElement> {
  iconOnly?: boolean;
}

const Logo: React.FC<LogoProps> = ({ className, iconOnly = false, ...props }) => {
  return (
    <div className={cn("flex items-center gap-2.5", className)} {...props}>
      <span className="brand-mark">
        <img
          src="/lovable-uploads/5e648747-34b7-4d8f-93fd-4dbd00aeeefc.png"
          alt="LeLab"
        />
      </span>
      {!iconOnly && <span className="brand-name">LeLab</span>}
    </div>
  );
};

export default Logo;
