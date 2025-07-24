import { Client } from "@notionhq/client";
import 'dotenv/config';
import { exec as execCallback } from 'child_process';
import util from 'util';
import { promises as fs } from 'fs';

const exec = util.promisify(execCallback);
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const pageId = process.env.NOTION_PAGE_ID;

/**
 * 로그 파일을 읽어 질문과 답변으로 분리합니다.
 * (가정: 첫 줄이 질문, 나머지가 답변)
 * @param {string} filePath - 로그 파일 경로
 * @returns {Promise<{question: string, answer: string}>}
 */
async function parseLogFile(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  
  if (lines.length < 2) {
    throw new Error('로그 파일 형식이 잘못되었습니다. 최소 두 줄 이상이어야 합니다 (질문, 답변).');
  }
  
  const question = lines[0];
  const answer = lines.slice(1).join('\n');
  
  return { question, answer };
}

/**
 * AI가 생성한 마크다운 텍스트를 Notion 블록 객체 배열로 변환합니다.
 * @param {string} markdown - 마크다운 형식의 텍스트
 * @returns {Array<Object>} - Notion 블록 객체 배열
 */
function parseMarkdownToNotionBlocks(markdown) {
  const blocks = [];
  const lines = markdown.split('\n');

  for (const line of lines) {
    // ### 제목 처리 (heading_3 사용)
    if (line.startsWith('### ')) {
      blocks.push({
        type: 'heading_3',
        heading_3: {
          rich_text: [{ type: 'text', text: { content: line.substring(4) } }],
        },
      });
    }
    // - 목록 처리
    else if (line.startsWith('- ')) {
      blocks.push({
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [{ type: 'text', text: { content: line.substring(2) } }],
        },
      });
    }
    // 빈 줄이 아닌 경우, 일반 문단으로 처리
    else if (line.trim() !== '') {
      blocks.push({
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: line } }],
        },
      });
    }
  }
  return blocks;
}

/**
 * 가공된 콘텐츠를 Notion 페이지에 추가합니다.
 * @param {string} title - 원본 질문
 * @param {string} markdownContent - AI가 재구성한 마크다운 콘텐츠
 */
async function addContentToPage(title, markdownContent) {
  if (!pageId) {
    throw new Error("오류: .env 파일에 NOTION_PAGE_ID가 설정되지 않았습니다.");
  }
  
  try {
    const notionBlocks = parseMarkdownToNotionBlocks(markdownContent);

    // Notion API는 한 번에 최대 100개의 블록만 추가할 수 있으므로, 100개씩 나눠서 요청합니다.
    for (let i = 0; i < notionBlocks.length; i += 100) {
      const chunk = notionBlocks.slice(i, i + 100);
      await notion.blocks.children.append({
        block_id: pageId,
        children: chunk,
      });
    }
    
    // 맨 마지막에 구분선을 추가합니다.
    await notion.blocks.children.append({
      block_id: pageId,
      children: [{ type: 'divider', divider: {} }],
    });

    console.log(`✅ Notion 페이지에 "${title}" 기록 성공!`);
  } catch (error) {
    console.error('Notion 페이지 추가 실패:', error.body || error);
  }
}

/**
 * AI에게 보낼 간결하고 명확한 프롬프트를 생성합니다.
 * @param {string} original_question - 원본 질문
 * @param {string} original_answer - 원본 답변
 * @returns {string} - 최종 프롬프트
 */
function createSimplePrompt(original_question, original_answer) {
  return `
[지시]
당신은 제공된 정보를 가공하는 사실 기반 어시스턴트입니다. 아래 규칙에 따라 [원본 답변]을 재구성하세요.

[규칙]
1.  **진실성:** 절대 정보를 지어내거나, 추측하거나, 내용을 변경하지 마세요. 원본에 있는 사실만 사용하세요.
2.  **완전성:** 원본의 어떤 정보도 생략하지 마세요.
3.  **형식:**
    - 각 섹션의 제목은 \`### 제목\` 형식으로 시작해야 합니다.
    - 목록은 \`- 항목\` 형식으로 만드세요.
    - 이외의 모든 내용은 일반 문단으로 작성하세요.

[재구성할 섹션]
- ### 질문 요지
- ### 답변 내용
- ### 핵심 개념
- ### 확인 필요 사항

---
[원본 질문]:
${original_question}

[원본 답변]:
${original_answer}
  `.trim();
}

/**
 * 메인 로직을 실행하는 함수
 * @param {string} logFilePath - 처리할 로그 파일의 경로
 */
async function main(logFilePath) {
  if (!logFilePath) {
    console.error("오류: 처리할 로그 파일 경로를 입력해 주세요. 예: node aiLog.js my_log.txt");
    return;
  }
  console.log(`📄 로그 파일 [${logFilePath}]을(를) 처리합니다...`);

  try {
    // 로그 파일에서 질문과 답변을 읽어옵니다.
    const { question: original_question, answer: original_answer } = await parseLogFile(logFilePath);
    console.log('🤖 로그 파일에서 질문과 답변을 성공적으로 읽었습니다.');

    // 답변 재구성 요청
    console.log('💬 답변을 재구성하도록 요청합니다...');
    const simplePrompt = createSimplePrompt(original_question, original_answer);
    
    const encodedPrompt = Buffer.from(simplePrompt).toString('base64');
    const structuringCommand = `echo "${encodedPrompt}" | base64 --decode | gemini chat`;

    const { stdout: finalContent, stderr } = await exec(structuringCommand);
    if (stderr) {
      return console.error('재구성 AI 실행 에러:', stderr);
    }
    console.log('📝 최종 정리된 내용을 받았습니다.');

    // Notion에 전송
    await addContentToPage(original_question, finalContent);

  } catch (error) {
    console.error('스크립트 실행 중 오류가 발생했습니다:', error.message);
  }
}

// 터미널에서 전달된 파일 경로 인자를 받아 메인 함수를 실행합니다.
const logFilePath = process.argv[2];
main(logFilePath);