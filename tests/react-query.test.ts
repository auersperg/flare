import { describe, expect, it, jest } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createClient, reference } from "../packages/sdk/src/client.js";
import { FlaredProvider, useQuery } from "../packages/sdk/src/react.js";

describe("React query contract", () => {
  it.each([{}, "skip"] as const)(
    "server rendering %p never starts a query or subscription",
    (args) => {
      const fetch = jest.fn();
      const client = createClient({ url: "https://backend.example", fetch });
      const onUpdate = jest.spyOn(client, "onUpdate");
      function View() {
        const result = useQuery(
          reference<{}, number>("counter/get", "query"),
          args,
        );
        return createElement("p", null, result ?? "Loading");
      }
      expect(
        renderToStaticMarkup(
          createElement(FlaredProvider, {
            client,
            children: createElement(View),
          }),
        ),
      ).toBe("<p>Loading</p>");
      expect(fetch).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
      client.dispose();
    },
  );
  it("requires an explicit provider instead of creating hidden clients", () => {
    function View() {
      useQuery(reference("counter/get", "query"), {});
      return null;
    }
    expect(() => renderToStaticMarkup(createElement(View))).toThrow(
      "FlaredProvider",
    );
  });
  it("rejects nonqueries even when skipped", () => {
    const client = createClient({ url: "https://backend.example" });
    function View() {
      useQuery(reference("counter/increment", "mutation"), "skip");
      return null;
    }
    expect(() =>
      renderToStaticMarkup(
        createElement(FlaredProvider, {
          client,
          children: createElement(View),
        }),
      ),
    ).toThrow("useQuery requires a query");
    client.dispose();
  });
});
