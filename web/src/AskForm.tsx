import { useState } from "react";
import type { AskAnswer, AskState } from "../../server/types.ts";
import { client } from "./client.ts";

const answerText = (a: AskAnswer | undefined) => {
  const parts = [...(a?.selected ?? []), ...(a?.text?.trim() ? [a.text.trim()] : [])];
  return parts.length ? parts.join("；") : "（未回答）";
};

/**
 * ask_user 的提问：每个问题可单选 / 多选候选项，也可以直接输入。
 * live：agent 还在等回答（对话结束或任务停止后只读）。
 */
export function AskForm({ id, ask, live }: { id: string; ask: AskState; live: boolean }) {
  const [answers, setAnswers] = useState<AskAnswer[]>([]);
  const [sent, setSent] = useState(false);
  const { questions } = ask;

  if (ask.answers !== undefined || !live || sent) {
    if (ask.answers === undefined && sent) return <div className="ask done muted">已回答，等待 AI 继续…</div>;
    if (!ask.answers) return <div className="ask done muted">{ask.answers === null ? "已跳过" : "未回答"}</div>;
    return (
      <div className="ask done">
        {questions.map((q, i) => (
          <div key={i} className="ask-qa">
            <div className="ask-q">{q.question}</div>
            <div className="ask-a">{answerText(ask.answers![i])}</div>
          </div>
        ))}
      </div>
    );
  }

  const get = (i: number): AskAnswer => answers[i] ?? { selected: [] };
  const set = (i: number, a: AskAnswer) => setAnswers((prev) => questions.map((_, j) => (j === i ? a : (prev[j] ?? { selected: [] }))));
  const answered = (i: number) => get(i).selected.length > 0 || !!get(i).text?.trim();
  const complete = questions.length > 0 && questions.every((_, i) => answered(i));

  const submit = (answers: AskAnswer[] | null) => {
    client.send({ type: "ask:answer", id, answers });
    setSent(true);
  };

  const pick = (i: number, label: string) => {
    const q = questions[i];
    const a = get(i);
    if (q.multiSelect) {
      const selected = a.selected.includes(label) ? a.selected.filter((s) => s !== label) : [...a.selected, label];
      set(i, { ...a, selected });
    } else {
      // 单选：选候选项就清掉自己输入的内容
      set(i, { selected: a.selected[0] === label ? [] : [label] });
    }
  };

  return (
    <div className="ask">
      {questions.map((q, i) => {
        const a = get(i);
        const options = q.options ?? [];
        return (
          <div key={i} className="ask-item">
            <div className="ask-q">
              {q.header && <span className="ask-tag">{q.header}</span>}
              {q.question}
              {q.multiSelect && <span className="muted">（可多选）</span>}
            </div>
            {options.length > 0 && (
              <div className="ask-options">
                {options.map((o) => (
                  <button
                    key={o.label}
                    className={`ask-opt ${a.selected.includes(o.label) ? "on" : ""}`}
                    onClick={() => pick(i, o.label)}
                  >
                    <span className={`ask-mark ${q.multiSelect ? "check" : "radio"}`} />
                    <span className="ask-opt-main">
                      <span className="ask-opt-label">{o.label}</span>
                      {o.description && <span className="ask-opt-desc">{o.description}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <input
              className="ask-input"
              placeholder={options.length ? (q.multiSelect ? "补充（可选）…" : "其他，直接输入…") : "输入你的回答…"}
              value={a.text ?? ""}
              onChange={(e) => {
                const text = e.target.value;
                // 单选时自己输入就取代候选项
                set(i, { selected: q.multiSelect || !text ? a.selected : [], text });
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && complete) submit(questions.map((_, j) => get(j)));
              }}
            />
          </div>
        );
      })}
      <div className="ask-actions">
        <button className="ghost" onClick={() => submit(null)}>
          跳过
        </button>
        <button className="primary" disabled={!complete} onClick={() => submit(questions.map((_, j) => get(j)))}>
          提交
        </button>
      </div>
    </div>
  );
}
