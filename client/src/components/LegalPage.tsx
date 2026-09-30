/**
 * Privacy Policy + Terms of Service — linkable via `#privacy` / `#terms`.
 *
 * These two documents are not decoration: no ad network (Google AdSense
 * included) and no paid ad campaign (Google Ads, Meta) will approve a site
 * without them, and they describe exactly what Matchup does with data:
 * accounts in the database, calls peer-to-peer, board shows aggregates only.
 *
 * Kept honest on purpose — if the app's behaviour changes, change this file.
 */
import { useEffect } from 'react';

export type LegalPageId = 'privacy' | 'terms';

interface Section {
  h: string;
  p: string[];
}

const COPY: Record<LegalPageId, { title: string; intro: string; sections: Section[] }> = {
  privacy: {
    title: 'Privacy Policy',
    intro:
      'This policy explains what Matchup stores, what it never sees, and your choices. ' +
      'Short version: your profile and (if you make one) your account live in our database, ' +
      'your calls travel directly between the two devices and are never recorded, and the ' +
      'public board only ever shows counts per country.',
    sections: [
      {
        h: 'What we store',
        p: [
          'Profile details you type into the lobby — username, age, gender, country and your matching preferences — are saved so the matchmaker can pair you. Profile rows are purged automatically after 30 days without use.',
          'If you create an account, we store your username and a salted, one-way hash of your password (we could not read your password even if we wanted to), plus a random session token so you stay signed in. The token itself only exists in your browser.',
          'Technical logs (errors, connection failures) may include IP addresses temporarily, purely to detect abuse and rate-limit spam. We do not build profiles from IP addresses.',
        ],
      },
      {
        h: 'What we never see',
        p: [
          'Your video and audio are peer-to-peer (WebRTC) and encrypted between the two participants. The server only introduces you to each other and carries signaling — it never receives, stores or reviews your media.',
          'Nothing is recorded. Screenshots and recordings are taken only by you, at your own risk and responsibility.',
          'The share card (countries + call length) is drawn inside your browser and uploaded nowhere; it leaves your device only if you choose to share it.',
        ],
      },
      {
        h: 'The live board',
        p: [
          '“Who’s online right now?” shows only aggregate counts per country — never names, ages, faces or any other identifier. Your country appears there only while you are in the queue.',
        ],
      },
      {
        h: 'Cookies and local storage',
        p: [
          'We use your browser’s local storage to keep you signed in and to remember your last lobby details on your own device. No tracking cookies are set by Matchup itself.',
        ],
      },
      {
        h: 'Advertising',
        p: [
          'When ads are shown, they are delivered by third-party ad networks (for example Google AdSense), which may use cookies or similar technologies to select and measure ads. You can control personalised advertising through your ad network’s settings (for Google: Ads Settings at https://adssettings.google.com). Refusing personalised ads does not stop ads from being shown.',
        ],
      },
      {
        h: 'Who may use Matchup',
        p: [
          'Matchup is strictly for people aged 18 or over. We do not knowingly collect data from minors; if we learn an account belongs to a minor it is deleted.',
        ],
      },
      {
        h: 'Your rights',
        p: [
          'Depending on where you live (including the EU/UK GDPR and similar laws), you may request a copy of your data, its correction or deletion, and you may object to processing. Signing out removes the session token from your device; to delete your account record, contact us and we will remove it. We never sell personal data.',
        ],
      },
      {
        h: 'Changes and contact',
        p: [
          'We will update this page if the app’s behaviour changes; the date below shows the latest revision. Questions? Use the contact address published alongside the app.',
        ],
      },
    ],
  },
  terms: {
    title: 'Terms of Service',
    intro:
      'By using Matchup you accept these terms. If you do not accept them, do not use the service.',
    sections: [
      {
        h: 'Eligibility',
        p: [
          'You must be 18 years or older to use Matchup. The service is not directed at minors, and accounts of under-18 users are removed when discovered.',
        ],
      },
      {
        h: 'Your account',
        p: [
          'You are responsible for the activity under your account and for keeping your password safe. Information you provide must be truthful. You may stop using the service and ask for your account to be deleted at any time.',
        ],
      },
      {
        h: 'Acceptable use',
        p: [
          'Matchup is for meeting new people in good faith. You agree not to: show, distribute or solicit sexual or explicit content; harass, threaten, humiliate or discriminate against anyone; impersonate others or misrepresent who you are; advertise, sell or solicit; record or screenshot other participants without their consent; distribute other people’s personal data; share content that is illegal, hateful, or infringes anyone’s rights; or interfere with, scrape or automate the service.',
          'Requests involving minors, any sexual content involving minors, or any form of exploitation are prohibited and will be reported to the relevant authorities.',
        ],
      },
      {
        h: 'Moderation and suspension',
        p: [
          'We may suspend or delete accounts and limit access to the service when we reasonably believe these terms are being broken, with or without prior notice. The live board and matchmaking are provided at our discretion.',
        ],
      },
      {
        h: 'Your content',
        p: [
          'You are solely responsible for the video, audio and text you transmit to your match. We do not monitor or store it, so think before you share — you cannot un-share it.',
        ],
      },
      {
        h: 'Service “as is”',
        p: [
          'Matchup is provided without warranties of any kind, express or implied. We do not guarantee uninterrupted availability, that you will be matched with anyone, or that the service will meet your expectations. To the maximum extent permitted by law, our liability is limited to the amount you paid us (nothing, if you use it for free).',
        ],
      },
      {
        h: 'Changes',
        p: [
          'We may revise these terms; continued use after an update means you accept the new version. The date below shows the latest revision.',
        ],
      },
    ],
  },
};

export default function LegalPage({
  page,
  onClose,
}: {
  page: LegalPageId;
  onClose: () => void;
}) {
  const doc = COPY[page];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="card max-h-[85vh] w-full max-w-2xl overflow-y-auto p-6 text-left"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={doc.title}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-ink">{doc.title}</h2>
            <p className="mt-1 text-xs text-muted">Last updated: 28 September 2026</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost shrink-0 px-3 py-1.5 text-xs"
            autoFocus
          >
            Close
          </button>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-muted">{doc.intro}</p>

        {doc.sections.map((section) => (
          <section key={section.h} className="mt-5">
            <h3 className="text-sm font-semibold text-ink">{section.h}</h3>
            {section.p.map((paragraph) => (
              <p key={paragraph} className="mt-2 text-sm leading-relaxed text-muted">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
