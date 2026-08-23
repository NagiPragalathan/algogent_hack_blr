/**
 * The footage, in one place.
 *
 * These are the site's existing assets and they are referenced from four
 * different sections; collecting them here is what makes "the hero video also
 * backs the third feature card" a fact you can see rather than a coincidence
 * between two string literals. Nothing here is a placeholder — every URL is
 * already serving.
 */
export const MEDIA = {
  /** Full-screen hero background, and the third feature card. */
  hero: "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260325_120549_0cd82c36-56b3-4dd9-b190-069cfc3a623f.mp4",
  /** Second feature card. */
  mission: "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260325_132944_a0d124bb-eaa1-4082-aa30-2310efb42b4b.mp4",
  /** First feature card. */
  solution: "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260325_125119_8e5ae31c-0021-4396-bc08-f7aebeb877a2.mp4",
  /** HLS, so it needs the player — the fourth feature card and the closing section. */
  stream: "https://stream.mux.com/8wrHPCX2dC3msyYU9ObwqNdm00u3ViXvOSHUMRYSEe5Q.m3u8",
} as const;
