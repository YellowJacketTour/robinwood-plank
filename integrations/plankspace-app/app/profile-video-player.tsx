import { parseYouTubeVideoIds } from "./profile-video-links";

export default function ProfileVideoPlayer({
  links,
  title,
}: {
  links: string;
  title: string;
}) {
  const ids = parseYouTubeVideoIds(links);
  const firstId = ids[0];
  if (!firstId) return <p className="public-empty">No featured video yet.</p>;

  const remaining = ids.slice(1);
  const playlist = remaining.length
    ? `&playlist=${encodeURIComponent(remaining.join(","))}`
    : "";
  const src = `https://www.youtube-nocookie.com/embed/${firstId}?playsinline=1&rel=0${playlist}`;

  return (
    <div className="profile-video-player">
      <div className="video-frame">
        <iframe
          src={src}
          title={`${title} — ${ids.length} saved video${ids.length === 1 ? "" : "s"}`}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>
    </div>
  );
}
