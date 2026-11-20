import type { Metadata } from "next"
import { AiModelsView } from "./ai-models-view"

export const metadata: Metadata = { title: "AI models" }

export default function AiModelsPage() {
  return <AiModelsView />
}
