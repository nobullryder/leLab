import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { UrdfProvider } from "@/contexts/UrdfContext";
import { DragAndDropProvider } from "@/contexts/DragAndDropContext";
import { Toaster } from "@/components/ui/toaster";
import Home from "@/pages/Home";
import Robot from "@/pages/Robot";
import Chat from "@/pages/Chat";
import Teleoperation from "@/pages/Teleoperation";
import Calibration from "@/pages/Calibration";
import Recording from "@/pages/Recording";
import Training from "@/pages/Training";
import Inference from "@/pages/Inference";
import Dataset from "@/pages/Dataset";
import Datasets from "@/pages/Datasets";
import Skills from "@/pages/Skills";

import NotFound from "@/pages/NotFound";
import SingleTabGuard from "@/components/SingleTabGuard";
import TeleopStopNotice from "@/components/TeleopStopNotice";
import UpdateNotice from "@/components/UpdateNotice";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { ApiProvider } from "./contexts/ApiContext";
import { HfAuthProvider } from "./contexts/HfAuthContext";
import AppShell from "@/components/app/AppShell";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider>
          <ApiProvider>
            <HfAuthProvider>
              <UrdfProvider>
                <DragAndDropProvider>
                  <BrowserRouter>
                    <SingleTabGuard>
                      <TeleopStopNotice />
                      <UpdateNotice />
                      <AppShell>
                        <Routes>
                          <Route path="/" element={<Home />} />
                          <Route path="/robot" element={<Robot />} />
                          <Route path="/skills" element={<Skills />} />
                          <Route path="/chat" element={<Chat />} />
                          <Route path="/teleoperation" element={<Teleoperation />} />
                          <Route path="/recording" element={<Recording />} />
                          <Route path="/training" element={<Training />} />
                          <Route path="/training/:jobId" element={<Training />} />
                          <Route path="/inference" element={<Inference />} />
                          <Route path="/calibration" element={<Calibration />} />
                          <Route path="/datasets" element={<Datasets />} />
                          <Route path="/dataset/*" element={<Dataset />} />

                          <Route path="*" element={<NotFound />} />
                        </Routes>
                      </AppShell>
                    </SingleTabGuard>
                    <Toaster />
                  </BrowserRouter>
                </DragAndDropProvider>
              </UrdfProvider>
            </HfAuthProvider>
          </ApiProvider>
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
