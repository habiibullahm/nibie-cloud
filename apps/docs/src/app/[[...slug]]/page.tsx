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

export async function generateMetadata(props: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await props.params
  const page = source.getPage(slug)
  if (!page) notFound()
  return { title: page.data.title, description: page.data.description }
}
