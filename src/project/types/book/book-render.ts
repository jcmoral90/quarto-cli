/*
* book-render.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { dirname, join, relative } from "path/mod.ts";

import { encode as base64Encode } from "encoding/base64.ts";

import { ld } from "lodash/mod.ts";

import { partitionMarkdown } from "../../../core/pandoc/pandoc-partition.ts";

import {
  kAbstract,
  kAuthor,
  kDate,
  kDescription,
  kNumberSections,
  kOutputExt,
  kOutputFile,
  kSubtitle,
  kTitle,
  kToc,
} from "../../../config/constants.ts";
import { Format, isHtmlOutput } from "../../../config/format.ts";

import {
  ExecutedFile,
  removePandocTo,
  RenderContext,
  renderContexts,
  RenderedFile,
  RenderOptions,
  renderPandoc,
} from "../../../command/render/render.ts";
import { outputRecipe } from "../../../command/render/output.ts";
import { renderCleanup } from "../../../command/render/cleanup.ts";

import { ProjectConfig, ProjectContext } from "../../project-context.ts";
import { ProjectOutputFile } from "../project-types.ts";

import { websiteOutputFiles, websitePostRender } from "../website/website.ts";

import {
  isMultiFileBookFormat,
  onSingleFileBookRendered,
} from "./book-extension.ts";
import {
  bookConfig,
  BookConfigKey,
  bookConfigRenderItems,
  bookOutputStem,
  BookRenderItem,
  isBookIndexPage,
} from "./book-config.ts";

import { chapterInfoForInput, withChapterMetadata } from "./book-chapters.ts";
import { bookCrossrefsPostRender } from "./book-crossrefs.ts";
import { bookBibliographyPostRender } from "./book-bibliography.ts";

export function bookPandocRenderer(
  options: RenderOptions,
  project: ProjectContext,
) {
  // rendered files to return. some formats need to end up returning all of the individual
  // renderedFiles (e.g. html or asciidoc) and some formats will consolidate all of their
  // files into a single one (e.g. pdf or epub)
  const renderedFiles: RenderedFile[] = [];

  // accumulate executed files for formats that need deferred rendering
  const executedFiles: Record<string, ExecutedFile[]> = {};

  // function to cleanup any files that haven't gone all the way
  // through the rendering pipeline
  const cleanupExecutedFiles = () => {
    for (const format of Object.keys(executedFiles)) {
      executedFiles[format].forEach((executedFile) => {
        cleanupExecutedFile(
          executedFile,
          executedFile.recipe.output,
        );
      });
    }
  };

  return {
    onBeforeExecute: (format: Format) => {
      return {
        // if we render a file at a time then resolve dependencies immediately
        resolveDependencies: isMultiFileBookFormat(format),
      };
    },

    onRender: async (format: string, file: ExecutedFile) => {
      // render immediately for multi-file book formats (with appropriate
      // handling of titles, headings, etc.)
      if (isMultiFileBookFormat(file.context.format)) {
        const partitioned = partitionMarkdown(file.executeResult.markdown);
        const fileRelative = relative(project.dir, file.context.target.source);

        // index file
        if (isBookIndexPage(fileRelative)) {
          file.recipe.format = withBookTitleMetadata(
            file.recipe.format,
            project.config,
          );
          file.recipe.format.metadata[kToc] = false;
          file.recipe.format.pandoc[kNumberSections] = false;
          // other files
        } else {
          // since this could be an incremental render we need to compute the chapter number
          const chapterInfo = isHtmlOutput(file.recipe.format.pandoc)
            ? chapterInfoForInput(project, fileRelative)
            : undefined;

          // provide title metadata
          if (partitioned.headingText) {
            file.recipe.format = withChapterMetadata(
              file.recipe.format,
              partitioned,
              chapterInfo,
              project.config,
            );
          }

          // provide markdown
          file.executeResult.markdown = partitioned.markdown;
        }

        // perform the render
        renderedFiles.push(await renderPandoc(file));

        // accumulate executed files for single file formats
      } else {
        executedFiles[format] = executedFiles[format] || [];
        executedFiles[format].push(file);
      }
    },
    onComplete: async (error?: boolean) => {
      // if there was an error during execution then cleanup any
      // executed files we've accumulated and return no rendered files
      if (error) {
        cleanupExecutedFiles();
        return {
          files: renderedFiles,
        };
      }

      // handle executed files
      try {
        const renderFormats = Object.keys(executedFiles);
        for (const renderFormat of renderFormats) {
          // get files
          const files = executedFiles[renderFormat];

          // determine the format from the first file
          if (files.length > 0) {
            const format = files[0].context.format;

            // if it's not a multi-file book then we need to render from the
            // accumulated exected files
            if (!isMultiFileBookFormat(format)) {
              renderedFiles.push(
                await renderSingleFileBook(
                  project!,
                  options,
                  files,
                ),
              );
            }
          }

          // remove the rendered files (indicating they have already been cleaned up)
          delete executedFiles[renderFormat];
        }

        return {
          files: renderedFiles,
        };
      } catch (error) {
        cleanupExecutedFiles();
        return {
          files: renderedFiles,
          error: error || new Error(),
        };
      }
    },
  };
}

async function renderSingleFileBook(
  project: ProjectContext,
  options: RenderOptions,
  files: ExecutedFile[],
): Promise<RenderedFile> {
  // we are going to compose a single ExecutedFile from the array we have been passed
  const executedFile = await mergeExecutedFiles(
    project,
    options,
    files,
  );

  // set book title metadata
  executedFile.recipe.format = withBookTitleMetadata(
    executedFile.recipe.format,
    project.config,
  );

  // do pandoc render
  const renderedFile = await renderPandoc(executedFile);

  // cleanup step for each executed file
  files.forEach((file) => {
    cleanupExecutedFile(
      file,
      join(project.dir, renderedFile.file),
    );
  });

  // call book extension if applicable
  onSingleFileBookRendered(project, renderedFile);

  // return rendered file
  return renderedFile;
}

async function mergeExecutedFiles(
  project: ProjectContext,
  options: RenderOptions,
  files: ExecutedFile[],
): Promise<ExecutedFile> {
  // base context on the first file
  const context = ld.cloneDeep(files[0].context) as RenderContext;

  // use global render options
  context.options = removePandocTo(options);

  // set output file based on book outputFile (or explicit config if provided)
  const outputStem = bookOutputStem(project.dir, project.config);
  context.format.pandoc[kOutputFile] = `${outputStem}.${
    context.format.render[kOutputExt]
  }`;

  // create output recipe (tweak output file)
  const recipe = await outputRecipe(context);

  const renderItems = bookConfigRenderItems(project.config);

  // merge markdown, writing a metadata comment into each file
  const markdown = renderItems.reduce(
    (markdown: string, item: BookRenderItem) => {
      // item markdown
      let itemMarkdown = "";

      // get executed file for book item
      if (item.file) {
        const itemInputPath = join(project.dir, item.file);
        const file = files.find((file) =>
          file.context.target.input === itemInputPath
        );
        if (file) {
          itemMarkdown = bookItemMetadata(project, item, file) +
            file.executeResult.markdown;
        } else {
          throw new Error(
            "Executed file not found for book item: " + item.file,
          );
        }
        // if there is no file then this must be a part
      } else if (item.type === "part" || item.type === "appendix") {
        itemMarkdown = bookPartMarkdown(project, item);
      }

      // if this is part divider, then surround it in a special div so we
      // can discard it in formats that don't support parts
      if (
        (item.type === "part" || item.type === "appendix") &&
        itemMarkdown.length > 0
      ) {
        itemMarkdown = `\n\n::: {.quarto-book-part}\n${itemMarkdown}\n:::\n\n`;
      }

      // fallthrough
      return markdown + itemMarkdown;
    },
    "",
  );

  // merge supporting
  const supporting = files.reduce(
    (supporting: string[], file: ExecutedFile) => {
      return ld.uniq(
        supporting.concat(
          file.executeResult.supporting.map((f) => relative(project.dir, f)),
        ),
      );
    },
    [] as string[],
  );

  // merge filters
  const filters = ld.uniq(files.flatMap((file) => file.executeResult.filters));

  // merge dependencies
  const dependencies = files.reduce(
    (dependencies: Array<unknown>, file: ExecutedFile) => {
      return dependencies.concat(
        file.executeResult.dependencies?.data as Array<unknown> || [],
      );
    },
    new Array<unknown>(),
  );

  // merge preserves
  const preserve = files.reduce(
    (preserve: Record<string, string>, file: ExecutedFile) => {
      return {
        ...preserve,
        ...file.executeResult.preserve,
      };
    },
    {} as Record<string, string>,
  );

  return Promise.resolve({
    context,
    recipe,
    executeResult: {
      markdown,
      supporting,
      filters,
      dependencies: {
        type: "dependencies",
        data: dependencies,
      },
      preserve,
    },
  });
}

export async function bookPostRender(
  context: ProjectContext,
  incremental: boolean,
  outputFiles: ProjectOutputFile[],
) {
  // get web output contained in the outputFiles passed to us
  const websiteFiles = websiteOutputFiles(outputFiles);

  // fixup crossrefs and bibliography for web output
  await bookBibliographyPostRender(context, incremental, websiteFiles);
  await bookCrossrefsPostRender(context, websiteFiles);

  // write website files
  websiteFiles.forEach((websiteFile) => {
    const doctype = websiteFile.doctype;
    const htmlOutput = (doctype ? doctype + "\n" : "") +
      websiteFile.doc.documentElement?.outerHTML!;
    Deno.writeTextFileSync(websiteFile.file, htmlOutput);
  });

  // run standard website stuff (search, etc.)
  await websitePostRender(context, incremental, outputFiles);
}

export async function bookIncrementalRenderAll(
  context: ProjectContext,
  options: RenderOptions,
  files: string[],
) {
  for (let i = 0; i < files.length; i++) {
    // get contexts (formats)
    const contexts = await renderContexts(
      files[i],
      options,
      context,
    );

    // do any of them have a single-file book extension?
    for (const context of Object.values(contexts)) {
      if (!isMultiFileBookFormat(context.format)) {
        return true;
      }
    }
  }
  // no single-file book extensions found
  return false;
}

function cleanupExecutedFile(
  file: ExecutedFile,
  finalOutput: string,
) {
  renderCleanup(
    file.context.target.input,
    finalOutput,
    file.recipe.format,
    file.executeResult.supporting,
    file.context.engine.keepMd(file.context.target.input),
  );
}

function bookItemMetadata(
  project: ProjectContext,
  item: BookRenderItem,
  file?: ExecutedFile,
) {
  const resourceDir = file
    ? relative(project.dir, dirname(file.context.target.input))
    : undefined;
  const inlineMetadata = {
    resourceDir: resourceDir || ".",
  };
  const blockMetadata = {
    ...inlineMetadata,
    bookItemType: item.type,
  };
  const inlineMetadataEncoced = base64Encode(JSON.stringify(inlineMetadata));
  const blockMetadataEncoded = base64Encode(JSON.stringify(blockMetadata));
  return `\n\n\`<!-- quarto-file-metadata: ${inlineMetadataEncoced} -->\`{=html}\n\n\`\`\`{=html}\n<!-- quarto-file-metadata: ${blockMetadataEncoded} -->\n\`\`\`\n\n`;
}

function bookPartMarkdown(project: ProjectContext, item: BookRenderItem) {
  const metadata = bookItemMetadata(project, item);
  return `${metadata}# ${item.text}\n\n`;
}

function withBookTitleMetadata(format: Format, config?: ProjectConfig): Format {
  format = ld.cloneDeep(format);
  if (config) {
    const setMetadata = (
      key: BookConfigKey,
    ) => {
      const value = bookConfig(key, config);
      if (value) {
        format.metadata[key] = value;
      }
    };
    setMetadata(kTitle);
    setMetadata(kSubtitle);
    setMetadata(kAuthor);
    setMetadata(kDate);
    setMetadata(kAbstract);
    setMetadata(kDescription);
  }
  return format;
}
