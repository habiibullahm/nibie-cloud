import { source } from "@/lib/source"
import { createFromSource } from "fumadocs-core/search/server"

// Static export: the search index is generated at build time and queried in the browser.
export const revalidate = false

export const { staticGET: GET } = createFromSource(source, {
  language: "indonesian",
})
