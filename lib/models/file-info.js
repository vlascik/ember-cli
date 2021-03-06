'use strict';

const fs = require('fs');
const RSVP = require('rsvp');
const chalk = require('chalk');
const EditFileDiff = require('./edit-file-diff');
const EOL = require('os').EOL;
const rxEOL = new RegExp(EOL, 'g');
const isBinaryFile = require('isbinaryfile').sync;
const canEdit = require('../utilities/open-editor').canEdit;
const processTemplate = require('../utilities/process-template');

const Promise = RSVP.Promise;
const readFile = RSVP.denodeify(fs.readFile);
const lstat = RSVP.denodeify(fs.stat);

function diffHighlight(line) {
  if (line[0] === '+') {
    return chalk.green(line);
  } else if (line[0] === '-') {
    return chalk.red(line);
  } else if (/^@@/.test(line)) {
    return chalk.cyan(line);
  } else {
    return line;
  }
}

class FileInfo {
  constructor(options) {
    this.action = options.action;
    this.outputBasePath = options.outputBasePath;
    this.outputPath = options.outputPath;
    this.displayPath = options.displayPath;
    this.inputPath = options.inputPath;
    this.templateVariables = options.templateVariables;
    this.ui = options.ui;
  }

  confirmOverwrite(path) {
    let promptOptions = {
      type: 'expand',
      name: 'answer',
      default: false,
      message: `${chalk.red('Overwrite')} ${path}?`,
      choices: [
        { key: 'y', name: 'Yes, overwrite', value: 'overwrite' },
        { key: 'n', name: 'No, skip', value: 'skip' },
      ],
    };

    let outputPathIsFile = false;
    try { outputPathIsFile = fs.statSync(this.outputPath).isFile(); } catch (err) { /* ignore */ }

    let canDiff = (
      !isBinaryFile(this.inputPath) && (
        !outputPathIsFile ||
        !isBinaryFile(this.outputPath)
      )
    );

    if (canDiff) {
      promptOptions.choices.push({ key: 'd', name: 'Diff', value: 'diff' });

      if (canEdit()) {
        promptOptions.choices.push({ key: 'e', name: 'Edit', value: 'edit' });
      }
    }

    return this.ui.prompt(promptOptions)
      .then(response => response.answer);
  }

  displayDiff() {
    let info = this,
        jsdiff = require('diff');
    return RSVP.hash({
      input: this.render(),
      output: readFile(info.outputPath),
    }).then(result => {
      let diff = jsdiff.createPatch(
        info.outputPath, result.output.toString().replace(rxEOL, '\n'), result.input.replace(rxEOL, '\n')
      );
      let lines = diff.split('\n');

      for (let i = 0; i < lines.length; i++) {
        info.ui.write(
          diffHighlight(lines[i] + EOL)
        );
      }
    });
  }

  render() {
    let path = this.inputPath,
        context = this.templateVariables;
    if (!this.rendered) {
      this.rendered = readFile(path)
        .then(content => lstat(path)
          .then(fileStat => {
            if (isBinaryFile(content, fileStat.size)) {
              return content;
            } else {
              try {
                return processTemplate(content.toString(), context);
              } catch (err) {
                err.message += ` (Error in blueprint template: ${path})`;
                throw err;
              }
            }
          }));
    }
    return this.rendered;
  }

  checkForConflict() {
    return new Promise((resolve, reject) => {
      fs.exists(this.outputPath, (doesExist, error) => {
        if (error) {
          reject(error);
          return;
        }
        let result;

        if (doesExist) {
          result = RSVP.hash({
            input: this.render(),
            output: readFile(this.outputPath),
          }).then(result => {
            let type;
            if (result.input.toString().replace(rxEOL, '\n') === result.output.toString().replace(rxEOL, '\n')) {
              type = 'identical';
            } else {
              type = 'confirm';
            }
            return type;
          });
        } else {
          result = 'none';
        }

        resolve(result);
      });
    });
  }

  confirmOverwriteTask() {
    let info = this;

    return function() {
      function doConfirm() {
        return info.confirmOverwrite(info.displayPath)
          .then(action => {
            if (action === 'diff') {
              return info.displayDiff().then(doConfirm);
            } else if (action === 'edit') {
              let editFileDiff = new EditFileDiff({ info });
              return editFileDiff.edit()
                .then(() => info.action = action)
                .catch(() => doConfirm())
                .then(() => info);
            } else {
              info.action = action;
              return info;
            }
          });
      }

      return doConfirm();
    };
  }
}

module.exports = FileInfo;
