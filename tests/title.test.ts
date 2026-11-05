import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedText, cleanTitle, titleInput, visibleText } from "../src/title.ts";

test("bounds Unicode without splitting surrogate pairs", () => {
  assert.equal(boundedText("😀😀😀", 2), "😀😀");
  assert.equal(Array.from(JSON.parse(titleInput("问".repeat(5000), "答".repeat(5000))).question).length, 2000);
});

test("only visible final text blocks are extracted", () => {
  assert.equal(visibleText([
    { type: "thinking", thinking: "secret" },
    { type: "toolCall", arguments: { secret: true } },
    { type: "image", data: "secret" },
    { type: "text", text: "comment", textSignature: '{"phase":"commentary"}' },
    { type: "text", text: "PLC复习试卷PDF整理" },
  ], 100), "PLC复习试卷PDF整理");
});

test("accepts natural titles, technical terms, English, and small harmless wrappers", () => {
  for (const title of ["frp内网穿透工具简介", "PLC复习试卷PDF整理", "杭州与上海实习岗位对比", "MCP开发实战指南", "C++内存管理", "Python Unit Testing"]) {
    assert.equal(cleanTitle(title), title);
  }
  assert.equal(cleanTitle(' 标题：“Pi会话自动命名扩展开发” '), "Pi会话自动命名扩展开发");
  assert.equal(cleanTitle('Title: "Python Debugging"'), "Python Debugging");
});

test("rejects multiline, invisible controls, Markdown, JSON, emoji, generic filler and oversized titles", () => {
  for (const title of ["", " ", "a\nb", "a\rb", "a\u001bb", "a\u202eb", "# 标题", "**标题**", '{"title":"标题"}', "😀标题", "关于插件的讨论", "题".repeat(31)]) {
    assert.equal(cleanTitle(title), undefined, JSON.stringify(title));
  }
  assert.equal(cleanTitle("题".repeat(30)), "题".repeat(30));
});
