import { notFound } from "next/navigation"
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page"
import defaultMdxComponents from "fumadocs-ui/mdx"
import { Step, Steps } from "fumadocs-ui/components/steps"
import { source } from "@/lib/source"

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await props.params
  const page = source.getPage(slug)
  if (!page) notFound()

  const MDX = page.data.body

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, Step, Steps }} />
      </DocsBody>
    </DocsPage>
  )
}

export function generateStaticParams() {
  return source.generateParams()
}

const DOCS_OG_IMAGE = {
  url: "/docs/og-image.png",
  width: 1200,
  height: 630,
  type: "image/png",
  alt: "Dokumentasi Nibie Cloud — Panduan deploy dan kelola agent AI Hermes.",
} as const

export async function generateMetadata(props: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await props.params
  const page = source.getPage(slug)
  if (!page) notFound()
  const title = page.data.title
  const fullTitle = `${title} · Nibie Cloud Docs`
  const description = page.data.description
  const url = slug?.length ? `/docs/${slug.join("/")}` : "/docs"
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      locale: "id_ID",
      siteName: "Nibie Cloud Docs",
      title: fullTitle,
      description,
      url,
      images: [DOCS_OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [{ url: DOCS_OG_IMAGE.url, alt: DOCS_OG_IMAGE.alt }],
    },
  }
}
