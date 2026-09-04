"use client";

import { useMemo, useState } from "react";
import { parseYouTubeVideoIds } from "./profile-video-links";

export default function ProfileVideoPlayer({
  links,
  title,
}: {
  links: string;
  title: string;
}) {
  const ids = useMemo(() => parseYouTubeVideoIds(links), [links]);
  const [selectedId, setSelectedId] = useState(ids[0] || "");
  const activeId = ids.includes(selectedId) ? selectedId : ids[0] || "";

  if (!activeId) return <p className="public-empty">No featured video yet.</p>;

  const selectedIndex = ids.indexOf(activeId);
  const src = `https://www.youtube-nocookie.com/embed/${activeId}?playsinline=1&rel=0`;

  return (
    <div className="profile-video-player">
      <div className="video-frame">
        <iframe
          key={activeId}
          src={src}
          title={`${title} — video ${selectedIndex + 1} of ${ids.length}`}
          loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin"
          allow="encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>
      {ids.length > 1 && (
        <div className="profile-video-choices" aria-label="Choose featured video">
          {ids.map((id, index) => (
            <button
              type="button"
              key={id}
              data-video-choice={id}
              aria-pressed={id === activeId}
              onClick={() => setSelectedId(id)}
            >
              <span>Video {index + 1} of {ids.length}</span>
              <small>{id === activeId ? "Now playing" : "Play video"}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
