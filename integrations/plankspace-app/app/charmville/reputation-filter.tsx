"use client";
import { REPUTATION_FACES, type ReputationFilter, type ReputationFace, type ReputationBasis, type ReputationMetric } from "@/lib/charmville/reputation";
import styles from "./reputation-search.module.css";

export const emptyCondition = (): ReputationFilter => ({ op: "gte", face: "stalk", basis: "current", metric: "totals", value: "0" });
type Props = { filter: ReputationFilter; onChange: (filter: ReputationFilter) => void; onRemove?: () => void; path?: string; depth?: number };
export function ReputationFilterEditor({ filter, onChange, onRemove, path = "1", depth = 0 }: Props) {
  const isGroup = "children" in filter, isNot = "child" in filter;
  const mode = isGroup || isNot ? filter.op : "condition";
  const setMode = (value: string) => {
    if (value === "condition") onChange(isNot ? filter.child : emptyCondition());
    else if (value === "not") onChange({ op: "not", child: filter });
    else onChange({ op: value as "all" | "any", children: isGroup ? filter.children : [filter] });
  };
  return <fieldset className={styles.filter}>
    <legend>Rule {path}</legend>
    <div className={styles.ruleHeader}>
      <label>Match<select aria-label={`Rule ${path} match`} value={mode} onChange={e => setMode(e.target.value)}>
        <option value="condition">A charm count</option><option value="all">ALL rules</option><option value="any">ANY rule</option><option value="not">NOT this rule</option>
      </select></label>
      {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove rule ${path}`}>Remove</button>}
    </div>
    {isGroup ? <>
      <p className={styles.note}>{filter.op === "all" ? "Every rule below must match." : "At least one rule below must match."}</p>
      {filter.children.map((child, index) => <ReputationFilterEditor key={index} filter={child} path={`${path}.${index + 1}`} depth={depth + 1}
        onChange={next => onChange({ ...filter, children: filter.children.map((existing, i) => i === index ? next : existing) })}
        onRemove={filter.children.length > 1 ? () => onChange({ ...filter, children: filter.children.filter((_, i) => i !== index) }) : undefined} />)}
      {depth < 10 && <button type="button" onClick={() => onChange({ ...filter, children: [...filter.children, emptyCondition()] })}>Add rule to {path}</button>}
    </> : isNot ? <>
      <p className={styles.note}>Exclude pines that match this rule.</p>
      <ReputationFilterEditor filter={filter.child} onChange={child => onChange({ op: "not", child })} path={`${path}.1`} depth={depth + 1} />
      <button type="button" onClick={() => onChange(filter.child)}>Remove NOT</button>
    </> : <div className={styles.condition}>
      <label>Charm<select aria-label={`Rule ${path} charm`} value={filter.face} onChange={e => onChange({ ...filter, face: e.target.value as ReputationFace })}>{REPUTATION_FACES.map(face => <option key={face} value={face}>{face[0].toUpperCase() + face.slice(1)}</option>)}</select></label>
      <label>Count<select aria-label={`Rule ${path} count`} value={filter.metric} onChange={e => onChange({ ...filter, metric: e.target.value as ReputationMetric })}><option value="totals">Total stamps</option><option value="supporters">Unique supporters</option></select></label>
      <label>History<select aria-label={`Rule ${path} history`} value={filter.basis} onChange={e => onChange({ ...filter, basis: e.target.value as ReputationBasis })}><option value="current">Current</option><option value="lifetime">Lifetime</option></select></label>
      <label>Comparison<select aria-label={`Rule ${path} comparison`} value={filter.op} onChange={e => {
        const key = { face: filter.face, basis: filter.basis, metric: filter.metric };
        const value = filter.op === "between" ? filter.min : filter.value;
        onChange(e.target.value === "between" ? { ...key, op: "between", min: value, max: value } : { ...key, op: e.target.value as "gte" | "lte" | "eq", value });
      }}><option value="gte">At least</option><option value="lte">At most</option><option value="eq">Exactly</option><option value="between">Between (inclusive)</option></select></label>
      {filter.op === "between" ? <>
        <label>Minimum<input aria-label={`Rule ${path} minimum`} inputMode="numeric" pattern="(0|[1-9][0-9]{0,39})" value={filter.min} required onChange={e => onChange({ ...filter, min: e.target.value })} /></label>
        <label>Maximum<input aria-label={`Rule ${path} maximum`} inputMode="numeric" pattern="(0|[1-9][0-9]{0,39})" value={filter.max} required onChange={e => onChange({ ...filter, max: e.target.value })} /></label>
      </> : <label>Value<input aria-label={`Rule ${path} value`} inputMode="numeric" pattern="(0|[1-9][0-9]{0,39})" value={filter.value} required onChange={e => onChange({ ...filter, value: e.target.value })} /></label>}
    </div>}
  </fieldset>;
}
