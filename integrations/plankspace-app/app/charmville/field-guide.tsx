import styles from "./porch.module.css";

export function FieldGuide({owner, claimed, ready, faces, seeds, onBag}: {
  owner:boolean; claimed:boolean; ready:number; faces:boolean; seeds:boolean; onBag:()=>void;
}) {
  return <details className={styles.fieldGuide}>
    <summary>Field guide <span>Your first harvest, your first mark</span></summary>
    <div className={styles.guideStory}>
      <h3>A little soil beneath the conversation</h3>
      <p>The Lumberyard began with boards and people with something to say. Now each board has a place to grow something worth sharing. Your garden feeds your satchel; your satchel leaves a mark on the conversation.</p>
      <p>Plank calls it cheap talk: a Stalk seed, a little time, and something to give. Your six beds stay yours—even after a week away.</p>
    </div>
    <ol className={styles.guideSteps}>
      <li><strong>Make yourself at home</strong><p>Sign in and claim your six beds. Your starter garden includes two ripe Stalk plots. Your profile and music stay right here.</p></li>
      <li><strong>Gather something to share</strong><p>Select a ripe bed, then Gather. The satchel opens with your harvest. Exactly one seed returns alongside the faces.</p></li>
      <li><strong>Put the seed back</strong><p>Choose Stalk, select an empty bed, then Plant here. One seed, zero grain. It grows in four hours.</p></li>
      <li><strong>Leave your first mark</strong><p>Write a pine in the composer above. Open your satchel, select Stalk and choose that pine. SEND spends one face to stamp it.</p></li>
      <li><strong>Make room for tomorrow</strong><p>Splinter takes sixteen hours, one seed and two grain. Arrange your trees, play your music, and visit another board to tend a growing crop.</p></li>
    </ol>
    <div className={styles.guideRules}><strong>The garden keeps its promise</strong><p>Both crops have a forty-eight-hour ripe window. Compost returns the seed and keeps the bed, but gives no faces. Visitors can tend; only the owner can harvest. A stamp spends a face, never a seed.</p></div>
    <div className={styles.guideNext} aria-live="polite"><strong>Your next step</strong><p>{!owner?"You are viewing a board. Sign in to verify ownership or tend a neighbor's growing crop.":!claimed?"Claim your lot below to begin.":ready?`${ready} ripe ${ready===1?"bed is":"beds are"} waiting. Use Find ripe plot, then Gather.`:faces?"You have faces to share. Open the satchel to choose a pine to stamp.":seeds?"A seed is waiting. Choose your crop and an empty bed to plant.":"Let your planted crops grow. You can write a pine, arrange scenery or visit a neighbor while you wait."}</p>{owner&&claimed&&faces&&<button onClick={onBag}>Open your harvest</button>}</div>
    <p className={styles.guideFuture}>The public market, crafting and shared adventure spaces belong to later chapters. They are not open in this build.</p>
  </details>;
}
