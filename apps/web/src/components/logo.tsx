type LogoProps = Readonly<{
  className?: string;
}>;

export function Logo({ className }: LogoProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M14.25 1.5H19L9.75 22.5H5L14.25 1.5Z" fill="currentColor" />
    </svg>
  );
}
