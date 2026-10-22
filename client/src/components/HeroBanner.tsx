/**
 * Photographic page banner — one image, the shared scrim, and a stack of real
 * copy sitting on the darkest corner (bottom-left, where `.photo-scrim` is at
 * 92% navy).
 *
 * Only the picture is decorative (`alt=""`): unlike the Feed and lobby heroes,
 * whose copy is repeated by a control row underneath and are therefore hidden
 * from assistive tech as a whole, the eyebrow/heading/text here *is* the page's
 * content, so the section stays in the accessibility tree. The heading level is
 * a prop because a page only ever wants one `<h1>` — Profile keeps its on the
 * identity card below.
 */
import type { ReactNode } from 'react';

interface HeroBannerProps {
  /** Path under `/img`, already sized for a wide band. */
  img: string;
  eyebrow?: string;
  title: ReactNode;
  /** Rendered as the `<h1>` by default; pass 'h2' when another h1 owns the page. */
  level?: 'h1' | 'h2';
  text?: string;
}

export default function HeroBanner({ img, eyebrow, title, level = 'h1', text }: HeroBannerProps) {
  const Heading = level;
  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/10">
      <img src={img} alt="" loading="eager" className="photo absolute inset-0 h-full w-full" />
      <div className="absolute inset-0 photo-scrim" aria-hidden="true" />
      {/* The copy sets the height; the photo fills it, so a short banner on a
          narrow phone never collapses the type into the image edge. */}
      <div className="relative flex min-h-36 flex-col justify-end p-5 sm:min-h-44 sm:p-6">
        {eyebrow && (
          <p className="animate-rise-in text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            {eyebrow}
          </p>
        )}
        <Heading className="animate-rise-in mt-1.5 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
          {title}
        </Heading>
        {text && (
          <p className="animate-rise-in mt-1 max-w-md text-sm leading-relaxed text-muted">{text}</p>
        )}
      </div>
    </section>
  );
}
