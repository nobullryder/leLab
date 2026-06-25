import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Return to the previous in-app page (browser back), falling back to a default
 * when there's no history to go back to — e.g. the page was deep-linked or
 * opened fresh. Use this for "Back" buttons so they return to wherever the
 * user came from instead of always jumping to a hardcoded route.
 */
export function useGoBack(fallback = "/") {
  const navigate = useNavigate();
  return useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate(fallback);
  }, [navigate, fallback]);
}
