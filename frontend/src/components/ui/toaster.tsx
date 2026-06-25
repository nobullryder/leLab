import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { buildErrorReport } from "@/lib/errorLog"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

function CopyErrorButton({ title, description }: { title: string; description: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(buildErrorReport(title, description))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (insecure context / denied) */
    }
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label="Copy error details"
      className="mt-1.5 inline-flex w-fit items-center gap-1.5 rounded-md border border-red-300/30 px-2 py-1 text-xs font-medium text-red-100/90 transition-colors hover:bg-red-500/20"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy details"}
    </button>
  )
}

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        const isError = variant === "destructive"
        const titleText = typeof title === "string" ? title : ""
        const descText = typeof description === "string" ? description : ""
        return (
          <Toast key={id} variant={variant} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
              {isError && <CopyErrorButton title={titleText} description={descText} />}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
