import type { SVGProps } from "react";

/**
 * Product marks shown next to the integrations they represent (Connections, onboarding).
 * Simplified vector renditions; swap for Google's official brand assets before a public launch.
 */
type Props = SVGProps<SVGSVGElement> & { size?: number };

export function GoogleMark({ size = 18, ...props }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...props}>
      <path
        fill="#4285F4"
        d="M22.5 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2-1.9 3.2-4.7 3.2-8z"
      />
      <path
        fill="#34A853"
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.3 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23z"
      />
      <path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7.1H2.1a11 11 0 0 0 0 9.9l3.7-2.8z" />
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4z"
      />
    </svg>
  );
}

export function GoogleCalendarIcon({ size = 32, ...props }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden {...props}>
      <path fill="#fff" d="M37 11H11v26h26z" />
      <path fill="#EA4335" d="M37 48l11-11H37z" />
      <path fill="#FBBC04" d="M48 11H37v26h11z" />
      <path fill="#34A853" d="M37 37H11v11h26z" />
      <path fill="#188038" d="M0 37v7.3A3.7 3.7 0 0 0 3.7 48H11V37z" />
      <path fill="#1967D2" d="M48 11V3.7A3.7 3.7 0 0 0 44.3 0H37v11z" />
      <path fill="#4285F4" d="M37 0H3.7A3.7 3.7 0 0 0 0 3.7V37h11V11h26z" />
      <text
        x="24"
        y="30.5"
        textAnchor="middle"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="15"
        fontWeight="700"
        fill="#4285F4"
      >
        31
      </text>
    </svg>
  );
}

export function GmailIcon({ size = 32, ...props }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden {...props}>
      <path fill="#4285F4" d="M4 38.5V14l8 6v21.5H6.5A2.5 2.5 0 0 1 4 38.5z" />
      <path fill="#34A853" d="M36 41.5V20l8-6v24.5a2.5 2.5 0 0 1-2.5 3z" />
      <path fill="#EA4335" d="M12 20l12 9 12-9v-8L24 21 12 12z" />
      <path fill="#C5221F" d="M4 11.5V14l8 6v-8l-3.6-2.7A2.8 2.8 0 0 0 4 11.5z" />
      <path fill="#FBBC04" d="M44 11.5V14l-8 6v-8l3.6-2.7a2.8 2.8 0 0 1 4.4 2.2z" />
    </svg>
  );
}

export function GoogleTasksIcon({ size = 32, ...props }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden {...props}>
      <circle cx="24" cy="24" r="22" fill="#2684FC" />
      <path fill="#0066DA" d="M24 46A22 22 0 0 1 2 24h22z" />
      <path fill="#FFBA00" d="M2 24A22 22 0 0 0 11 41.8L24 24z" />
      <path
        d="M14.5 24.5l6.5 6.5 13-14"
        fill="none"
        stroke="#fff"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function GoogleDriveIcon({ size = 32, ...props }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden {...props}>
      <path fill="#0066DA" d="M7.6 38.2l2 3.5c.4.7 1 1.3 1.7 1.7l7-12.2H4.3c0 .8.2 1.6.6 2.3z" />
      <path
        fill="#00AC47"
        d="M24 17.4l-7-12.2c-.7.4-1.3 1-1.7 1.7L4.9 25c-.4.7-.6 1.5-.6 2.3h14z"
      />
      <path
        fill="#EA4335"
        d="M36.7 43.4c.7-.4 1.3-1 1.7-1.7l.8-1.4 3.9-6.8c.4-.7.6-1.5.6-2.3H29.7l3 5.9z"
      />
      <path fill="#00832D" d="M24 17.4l7-12.2c-.7-.4-1.5-.6-2.3-.6h-9.4c-.8 0-1.6.2-2.3.6z" />
      <path fill="#2684FC" d="M29.7 31.2H18.3l-7 12.2c.7.4 1.5.6 2.3.6h20.8c.8 0 1.6-.2 2.3-.6z" />
      <path
        fill="#FFBA00"
        d="M36.6 18.2l-6.5-11.3c-.4-.7-1-1.3-1.7-1.7l-7 12.2 8.3 14h14c0-.8-.2-1.6-.6-2.3z"
      />
    </svg>
  );
}

export function GoogleSheetsIcon({ size = 32, ...props }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden {...props}>
      <path fill="#0F9D58" d="M29 3H12a4 4 0 0 0-4 4v34a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4V14z" />
      <path fill="#87CEAC" d="M29 3v8a3 3 0 0 0 3 3h8z" />
      <path
        fill="#F1F1F1"
        d="M15 21h18v15H15zm2.5 2.5v3.8h5.3v-3.8zm7.7 0v3.8h5.3v-3.8zm-7.7 6.2v3.8h5.3v-3.8zm7.7 0v3.8h5.3v-3.8z"
        fillRule="evenodd"
      />
    </svg>
  );
}

export function NotionIcon({ size = 32, ...props }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden {...props}>
      <rect x="6" y="5" width="36" height="38" rx="6" fill="#fff" stroke="#111" strokeWidth="3" />
      <path
        d="M17 34V15l14 19V15"
        fill="none"
        stroke="#111"
        strokeWidth="3.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SpotifyIcon({ size = 32, ...props }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...props}>
      <circle cx="12" cy="12" r="11" fill="#1ED760" />
      <path
        fill="none"
        stroke="#000"
        strokeLinecap="round"
        strokeWidth="1.9"
        d="M6.6 9.4c3.7-1.1 7.6-.8 10.9 1"
      />
      <path
        fill="none"
        stroke="#000"
        strokeLinecap="round"
        strokeWidth="1.6"
        d="M7.2 12.6c3-.8 6-.5 8.6.9"
      />
      <path
        fill="none"
        stroke="#000"
        strokeLinecap="round"
        strokeWidth="1.3"
        d="M7.8 15.5c2.4-.6 4.6-.4 6.6.7"
      />
    </svg>
  );
}

export function YouTubeIcon({ size = 32, ...props }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden {...props}>
      <rect x="1" y="4.5" width="22" height="15" rx="4.5" fill="#FF0000" />
      <path fill="#fff" d="M10 8.7v6.6l5.6-3.3z" />
    </svg>
  );
}
