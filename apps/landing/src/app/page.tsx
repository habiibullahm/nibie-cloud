import { ClosingCta } from "@/components/site/closing-cta"
import { Faq } from "@/components/site/faq"
import { Features } from "@/components/site/features"
import { Hero } from "@/components/site/hero"
import { HowItWorks } from "@/components/site/how-it-works"
import { Pricing } from "@/components/site/pricing"

export default function HomePage() {
  return (
    <>
      <Hero />
      <Features />
      <HowItWorks />
      <Pricing />
      <Faq />
      <ClosingCta />
    </>
  )
}
