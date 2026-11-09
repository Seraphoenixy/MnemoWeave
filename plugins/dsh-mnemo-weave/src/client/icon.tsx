/** Sidebar glyph: three stacked layers, the middle one lit, read as a memory stack. */
export function MnemoWeaveIcon(props: { size?: number }): JSX.Element {
  const size = props.size ?? 16;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-dsh-plugin="dsh-mnemo-weave"
      data-dsh-part="sidebar-icon"
    >
      <path d="M12 3.5 20 7.6l-8 4.1-8-4.1 8-4.1Z" />
      <path d="M4 12.2l8 4.1 8-4.1" opacity="0.85" />
      <path d="M4 16.6l8 4.1 8-4.1" opacity="0.6" />
      <circle cx="12" cy="7.6" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}
