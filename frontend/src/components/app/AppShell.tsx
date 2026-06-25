import React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Bot, Database, GraduationCap, Home, MessageSquare, Sparkles } from "lucide-react";
import HfAuthChip from "@/components/landing/HfAuthChip";
import Footer from "@/components/Footer";
import Logo from "@/components/Logo";
import { useRobots } from "@/hooks/useRobots";

const navItems = [
  { to: "/", label: "Home", Icon: Home },
  { to: "/robot", label: "Robot", Icon: Bot },
  { to: "/datasets", label: "Datasets", Icon: Database },
  { to: "/training", label: "Train", Icon: GraduationCap },
  { to: "/skills", label: "Skills", Icon: Sparkles },
  { to: "/chat", label: "Chat", Icon: MessageSquare },
];

const focusRoutes = ["/recording", "/inference"];

function isActive(pathname: string, to: string) {
  if (to === "/") return pathname === "/";
  if (to === "/training") return pathname.startsWith("/training");
  // The "Datasets" tab also owns the singular detail route (/dataset/:repoId).
  if (to === "/datasets") return pathname.startsWith("/dataset");
  return pathname === to || pathname.startsWith(`${to}/`);
}

const RobotChip: React.FC = () => {
  const navigate = useNavigate();
  const { selectedRecord } = useRobots();

  if (!selectedRecord) {
    return (
      <button className="pill" onClick={() => navigate("/robot")}>
        <span className="dot dot-idle" />
        Add a robot
      </button>
    );
  }
  const ready = selectedRecord.is_clean;
  return (
    <button
      className={ready ? "pill pill-live" : "pill pill-amber"}
      onClick={() => navigate("/robot")}
      title={ready ? "Robot ready" : "Robot needs setup"}
    >
      <span className={ready ? "dot dot-live" : "dot dot-amber"} />
      <span className="max-w-[9rem] truncate normal-case">{selectedRecord.name}</span>
    </button>
  );
};

const Nav: React.FC<{ pathname: string; mobile?: boolean }> = ({ pathname, mobile }) => (
  <nav className={mobile ? "topnav-mobile" : "topnav"} aria-label="Primary">
    {navItems.map(({ to, label, Icon }) => (
      <Link
        key={to}
        to={to}
        className={mobile ? "pill shrink-0 normal-case" : "topnav-link"}
        data-active={isActive(pathname, to)}
      >
        <Icon className="h-4 w-4" />
        {label}
      </Link>
    ))}
  </nav>
);

const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { pathname } = useLocation();
  const isFocus = focusRoutes.some((route) => pathname.startsWith(route));

  if (isFocus) {
    return <div className="focus-root">{children}</div>;
  }

  return (
    <div className="app-root app-frame">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="rail-brand" aria-label="LeLab home">
            <Logo iconOnly />
            <span className="brand-name hidden sm:block">LeLab</span>
          </Link>

          <Nav pathname={pathname} />

          <div className="ml-auto flex items-center gap-2.5">
            <RobotChip />
            <HfAuthChip />
          </div>
        </div>
        <Nav pathname={pathname} mobile />
      </header>

      <main className="app-main">{children}</main>
      <Footer />
    </div>
  );
};

export default AppShell;
