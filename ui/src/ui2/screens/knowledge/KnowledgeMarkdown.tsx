// ui/src/ui2/screens/knowledge/KnowledgeMarkdown.tsx
//
// The page body as rendered Markdown (headings, lists, code, tables, links),
// shared by the UI2 screen and the Knowledge screen of the current interface.
// `[[wiki]]` links and relative `*.md` links both land on the screen's routes.

import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "@/lib/router";
import {
  knowledgeBodyToMarkdown,
  knowledgeHref,
  parseKnowledgeBody,
  resolveKnowledgeMarkdownHref,
} from "./knowledgeModel";

export function KnowledgeMarkdown({
  body,
  spaceKey,
  basePath,
}: {
  body: string;
  spaceKey: string;
  basePath: string;
}) {
  const markdown = useMemo(
    () => knowledgeBodyToMarkdown(parseKnowledgeBody(body), spaceKey, basePath),
    [body, spaceKey, basePath],
  );
  return (
    <div className="ui2-knowledge-body flex flex-col gap-3 text-sm leading-relaxed break-words">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (/^\s*javascript:/i.test(url) ? "" : url)}
        components={{
          h1: (props) => <h1 className="mt-2 text-2xl font-semibold" {...stripNode(props)} />,
          h2: (props) => <h2 className="mt-2 text-xl font-semibold" {...stripNode(props)} />,
          h3: (props) => <h3 className="mt-1 text-lg font-medium" {...stripNode(props)} />,
          h4: (props) => <h4 className="mt-1 text-base font-medium" {...stripNode(props)} />,
          p: (props) => <p className="whitespace-pre-wrap" {...stripNode(props)} />,
          ul: (props) => <ul className="list-disc pl-6" {...stripNode(props)} />,
          ol: (props) => <ol className="list-decimal pl-6" {...stripNode(props)} />,
          blockquote: (props) => (
            <blockquote className="border-l-2 border-border pl-3 text-muted-foreground" {...stripNode(props)} />
          ),
          pre: (props) => (
            <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-xs" {...stripNode(props)} />
          ),
          code: (props) => <code className="rounded-sm bg-muted px-1 font-mono text-xs" {...stripNode(props)} />,
          table: (props) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs" {...stripNode(props)} />
            </div>
          ),
          th: (props) => <th className="border border-border px-2 py-1 text-left font-medium" {...stripNode(props)} />,
          td: (props) => <td className="border border-border px-2 py-1" {...stripNode(props)} />,
          a: ({ href, children }) => {
            const link = "text-primary underline underline-offset-2";
            const target = href ? resolveKnowledgeMarkdownHref(href, spaceKey) : null;
            if (target) {
              return (
                <Link to={knowledgeHref(target, basePath)} className={`ui2-knowledge-link ${link}`}>
                  {children}
                </Link>
              );
            }
            if (href && href.startsWith(`${basePath}/`)) {
              return (
                <Link to={href} className={`ui2-knowledge-link ${link}`}>
                  {children}
                </Link>
              );
            }
            if (href && href.startsWith("#")) {
              return (
                <a href={href} className={link}>
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener" className={link}>
                {children}
              </a>
            );
          },
        }}
      >
        {markdown}
      </Markdown>
    </div>
  );
}

/** react-markdown hands the hast `node` to every component; keep it off the DOM. */
function stripNode<T extends { node?: unknown }>(props: T): Omit<T, "node"> {
  const { node: _node, ...rest } = props;
  void _node;
  return rest;
}
