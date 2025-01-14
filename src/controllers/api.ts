import { Application, Request, Response } from "express";
import httpContext from "express-http-context";
import fs from "fs";
import {
  JSONRPCErrorResponse,
  JSONRPCParams,
  JSONRPCResponse,
  JSONRPCServer,
} from "json-rpc-2.0";
import multer from "multer";
import Datastore from "nedb-promises";
import { homedir } from "os";
import path from "path";

import {
  CannotChangeAck,
  CannotChangeUploadedFile,
  InvalidAck,
  InvalidAttachmentID,
  InvalidBlindedUTXO,
  MissingAck,
  MissingAttachmentID,
  MissingBlindedUTXO,
  MissingFile,
  NotFoundConsignment,
  NotFoundMedia,
} from "../errors";
import { logger, oldAPILogger } from "../logger";
import { genHashFromFile, setDir } from "../util";
import { APP_DIR } from "../vars";
import { APP_VERSION } from "../version";

const PROTOCOL_VERSION = "0.1";

const DATABASE_FILE = "app.db";

const appDir = path.join(homedir(), APP_DIR);
const tempDir = path.join(appDir, "tmp");
const consignmentDir = path.join(appDir, "consignments");
const mediaDir = path.join(appDir, "media");

// We make sure the directories exist
setDir(tempDir);
setDir(consignmentDir);
setDir(mediaDir);

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, tempDir);
  },
});

const upload = multer({ storage });

interface ServerInfo {
  version: string;
  protocol_version: string;
  uptime: number;
}

interface Consignment {
  _id?: string;
  filename: string;
  blindedutxo: string;
  ack?: boolean;
  nack?: boolean; // to be removed when removing old APIs
  responded?: boolean; // to be removed when removing old APIs
}

interface Media {
  filename: string;
  attachment_id: string;
}

const ds = Datastore.create(path.join(homedir(), APP_DIR, DATABASE_FILE));

const middleware = (req: Request, _res: Response, next: () => void) => {
  oldAPILogger.notice("", { req });

  next();
};

function isBoolean(data: unknown): data is boolean {
  return Boolean(data) === data;
}

function isDictionary(data: unknown): data is Record<keyof never, unknown> {
  return typeof data === "object" && !Array.isArray(data) && data !== null;
}

function isString(data: unknown): data is string {
  return typeof data === "string";
}

function isErrorResponse(
  object: JSONRPCResponse
): object is JSONRPCErrorResponse {
  return "error" in object;
}

function truncateText(content: string, limit = 16) {
  if (!content) return "";
  if (content.length <= limit) return content;
  return content.slice(0, limit) + "...";
}

function joinEntries(entries: object) {
  let joined = "<";
  let keysCount = Object.keys(entries).length;
  Object.entries(entries).forEach(([k, v]) => {
    let value = v;
    if (isString(v)) {
      value = truncateText(v as string);
    }
    joined += `${k}: ${value}`;
    keysCount--;
    if (keysCount > 0) {
      joined += ", ";
    }
  });
  return joined + ">";
}

function getAckParam(jsonRpcParams: Partial<JSONRPCParams> | undefined) {
  const ackKey = "ack";
  if (!isDictionary(jsonRpcParams) || !(ackKey in jsonRpcParams)) {
    throw new MissingAck(jsonRpcParams);
  }
  const ack = jsonRpcParams[ackKey];
  if (!isBoolean(ack)) {
    throw new InvalidAck(jsonRpcParams);
  }
  return ack as boolean;
}

function getAttachmentIDParam(
  jsonRpcParams: Partial<JSONRPCParams> | undefined
) {
  const attachmentIDKey = "attachment_id";
  if (!isDictionary(jsonRpcParams) || !(attachmentIDKey in jsonRpcParams)) {
    throw new MissingAttachmentID(jsonRpcParams);
  }
  const attachmentID = jsonRpcParams[attachmentIDKey];
  if (!attachmentID || !isString(attachmentID)) {
    throw new InvalidAttachmentID(jsonRpcParams);
  }
  return attachmentID as string;
}

function getBlindedUTXOParam(
  jsonRpcParams: Partial<JSONRPCParams> | undefined
) {
  const blindedUTXOKey = "blinded_utxo";
  if (!isDictionary(jsonRpcParams) || !(blindedUTXOKey in jsonRpcParams)) {
    throw new MissingBlindedUTXO(jsonRpcParams);
  }
  const blindedUTXO = jsonRpcParams[blindedUTXOKey];
  if (!blindedUTXO || !isString(blindedUTXO)) {
    throw new InvalidBlindedUTXO(jsonRpcParams);
  }
  return blindedUTXO as string;
}

async function getConsignment(
  jsonRpcParams: Partial<JSONRPCParams> | undefined
) {
  const blindedUTXO = getBlindedUTXOParam(jsonRpcParams);
  const consignment: Consignment | null = await ds.findOne({
    blindedutxo: blindedUTXO,
  });
  if (!consignment) {
    throw new NotFoundConsignment(jsonRpcParams);
  }
  return consignment;
}

interface ServerParams {
  file: Express.Multer.File | undefined;
}

const jsonRpcServer: JSONRPCServer<ServerParams> =
  new JSONRPCServer<ServerParams>({
    errorListener: () => {
      /* avoid too verbose error logs */
    },
  });

jsonRpcServer.addMethod(
  "server.info",
  async (_jsonRpcParams, _serverParams): Promise<ServerInfo> => {
    return {
      protocol_version: PROTOCOL_VERSION,
      version: APP_VERSION,
      uptime: Math.trunc(process.uptime()),
    };
  }
);

jsonRpcServer.addMethod(
  "consignment.get",
  async (jsonRpcParams, _serverParams): Promise<string> => {
    const consignment = await getConsignment(jsonRpcParams);
    const fileBuffer = fs.readFileSync(
      path.join(consignmentDir, consignment.filename)
    );
    return fileBuffer.toString("base64");
  }
);

jsonRpcServer.addMethod(
  "consignment.post",
  async (jsonRpcParams, serverParams): Promise<boolean> => {
    const file = serverParams?.file;
    try {
      const blindedUTXO = getBlindedUTXOParam(jsonRpcParams);
      if (!file) {
        throw new MissingFile(jsonRpcParams);
      }
      const uploadedFile = path.join(tempDir, file.filename);
      const fileHash = genHashFromFile(uploadedFile);
      const prevFile: Consignment | null = await ds.findOne({
        blindedutxo: blindedUTXO,
      });
      if (prevFile) {
        if (prevFile.filename === fileHash) {
          fs.unlinkSync(path.join(tempDir, file.filename));
          return false;
        } else {
          throw new CannotChangeUploadedFile(jsonRpcParams);
        }
      }
      fs.renameSync(uploadedFile, path.join(consignmentDir, fileHash));
      const consignment: Consignment = {
        filename: fileHash,
        blindedutxo: blindedUTXO,
      };
      await ds.insert(consignment);
      return true;
    } catch (e: unknown) {
      if (file) {
        const unhandledFile = path.join(tempDir, file.filename);
        if (fs.existsSync(unhandledFile)) {
          fs.unlinkSync(unhandledFile);
        }
      }
      throw e;
    }
  }
);

jsonRpcServer.addMethod(
  "media.get",
  async (jsonRpcParams, _serverParams): Promise<string> => {
    const attachmentID = getAttachmentIDParam(jsonRpcParams);
    const media: Media | null = await ds.findOne({
      attachment_id: attachmentID,
    });
    if (!media) {
      throw new NotFoundMedia(jsonRpcParams);
    }
    const fileBuffer = fs.readFileSync(path.join(mediaDir, media.filename));
    return fileBuffer.toString("base64");
  }
);

jsonRpcServer.addMethod(
  "media.post",
  async (jsonRpcParams, serverParams): Promise<boolean> => {
    const file = serverParams?.file;
    try {
      const attachmentID = getAttachmentIDParam(jsonRpcParams);
      if (!file) {
        throw new MissingFile(jsonRpcParams);
      }
      const uploadedFile = path.join(tempDir, file.filename);
      const fileHash = genHashFromFile(uploadedFile);
      const prevFile: Media | null = await ds.findOne({
        attachment_id: attachmentID,
      });
      if (prevFile) {
        if (prevFile.filename === fileHash) {
          fs.unlinkSync(path.join(tempDir, file.filename));
          return false;
        } else {
          throw new CannotChangeUploadedFile(jsonRpcParams);
        }
      }
      fs.renameSync(uploadedFile, path.join(mediaDir, fileHash));
      const media: Media = {
        filename: fileHash,
        attachment_id: attachmentID,
      };
      await ds.insert(media);
      return true;
    } catch (e: unknown) {
      if (file) {
        const unhandledFile = path.join(tempDir, file.filename);
        if (fs.existsSync(unhandledFile)) {
          fs.unlinkSync(unhandledFile);
        }
      }
      throw e;
    }
  }
);

jsonRpcServer.addMethod(
  "ack.get",
  async (jsonRpcParams, _serverParams): Promise<boolean | undefined> => {
    const consignment = await getConsignment(jsonRpcParams);
    return consignment.ack;
  }
);

jsonRpcServer.addMethod(
  "ack.post",
  async (jsonRpcParams, _serverParams): Promise<boolean> => {
    const consignment = await getConsignment(jsonRpcParams);
    const ack = getAckParam(jsonRpcParams);
    if (consignment.ack != null) {
      if (consignment.ack === ack) {
        return false;
      } else {
        throw new CannotChangeAck(jsonRpcParams);
      }
    }
    await ds.update(
      { blindedutxo: consignment.blindedutxo },
      { $set: { ack: ack } },
      { multi: false }
    );
    return true;
  }
);

export const loadApiEndpoints = (app: Application): void => {
  app.post(
    "/json-rpc",
    upload.single("file"),
    async (req: Request, res: Response) => {
      // request logs
      const jsonRPCRequest = req.body;
      let reqParams = "";
      if (jsonRPCRequest.params !== null) {
        if (isString(jsonRPCRequest.params)) {
          jsonRPCRequest.params = JSON.parse(jsonRPCRequest.params);
        }
        if (isDictionary(jsonRPCRequest.params)) {
          reqParams = joinEntries(jsonRPCRequest.params);
        }
      }
      httpContext.set("apiMethod", req.body["method"]);
      httpContext.set("reqParams", reqParams);
      httpContext.set("clientID", jsonRPCRequest.id);
      logger.info("", { req });

      // call API method
      const file = req.file;
      jsonRpcServer
        .receive(jsonRPCRequest, { file })
        .then((jsonRPCResponse) => {
          if (jsonRPCResponse) {
            // response logs
            let response = "";
            if (isErrorResponse(jsonRPCResponse)) {
              response =
                `err <code: ${jsonRPCResponse.error.code}, ` +
                `message: ${jsonRPCResponse.error.message}>`;
            } else {
              response = "res ";
              const result = jsonRPCResponse.result;
              if (isDictionary(result)) {
                response += joinEntries(result);
              } else {
                response += "<";
                if (isString(result)) {
                  response += truncateText(result);
                } else {
                  response += result;
                }
                response += ">";
              }
            }
            httpContext.set("response", response);

            // send response to client
            res.json(jsonRPCResponse);
          } else {
            // notification
            res.sendStatus(204);
          }

          // delete possibly unhandled file
          if (file) {
            const unhandledFile = path.join(tempDir, file.filename);
            if (fs.existsSync(unhandledFile)) {
              logger.warning(`Deleting unhandled file: ${unhandledFile}`);
              fs.unlinkSync(unhandledFile);
            }
          }
        });
    }
  );

  app.get(
    "/consignment/:blindedutxo",
    middleware,
    async (req: Request, res: Response) => {
      try {
        if (!!req.params.blindedutxo) {
          const c: Consignment | null = await ds.findOne({
            blindedutxo: req.params.blindedutxo,
          });
          if (!c) {
            return res.status(404).send({
              success: false,
              error: "No consignment found!",
            });
          }
          const file_buffer = fs.readFileSync(
            path.join(consignmentDir, c.filename)
          );

          return res.status(200).send({
            success: true,
            consignment: file_buffer.toString("base64"),
          });
        }

        res.status(400).send({ success: false, error: "blindedutxo missing!" });
      } catch (error) {
        res.status(500).send({ success: false });
      }
    }
  );

  app.post(
    "/consignment",
    upload.single("consignment"),
    async (req: Request, res: Response) => {
      try {
        if (!req.body.blindedutxo) {
          return res
            .status(400)
            .send({ success: false, error: "blindedutxo missing!" });
        }
        httpContext.set("blindedutxo", req.body.blindedutxo);
        oldAPILogger.notice("", { req: req });
        if (!req.file) {
          return res
            .status(400)
            .send({ success: false, error: "Consignment file is missing!" });
        }
        const fileHash = genHashFromFile(path.join(tempDir, req.file.filename));
        const prevConsignment: Consignment | null = await ds.findOne({
          blindedutxo: req.body.blindedutxo,
        });
        if (prevConsignment) {
          if (prevConsignment.filename == fileHash) {
            return res.status(200).send({ success: true });
          } else {
            return res
              .status(403)
              .send({ success: false, error: "Cannot change uploaded file!" });
          }
        }
        // We move the file with the hash as name
        fs.renameSync(
          path.join(tempDir, req.file.filename),
          path.join(consignmentDir, fileHash)
        );
        const consignment: Consignment = {
          filename: fileHash,
          blindedutxo: req.body.blindedutxo,
        };
        await ds.insert(consignment);
        if (fs.existsSync(path.join(tempDir, req.file.filename))) {
          // We delete the file from the uploads directory
          fs.unlinkSync(path.join(tempDir, req.file.filename));
        }

        return res.status(200).send({ success: true });
      } catch (error) {
        res.status(500).send({ success: false });
      }
    }
  );

  app.get(
    "/media/:attachment_id",
    middleware,
    async (req: Request, res: Response) => {
      try {
        if (!!req.params.attachment_id) {
          const media: Media | null = await ds.findOne({
            attachment_id: req.params.attachment_id,
          });
          if (!media) {
            return res.status(404).send({
              success: false,
              error: "No media found!",
            });
          }
          const file_buffer = fs.readFileSync(
            path.join(mediaDir, media.filename)
          );

          return res.status(200).send({
            success: true,
            media: file_buffer.toString("base64"),
          });
        }

        res
          .status(400)
          .send({ success: false, error: "attachment_id missing!" });
      } catch (error) {
        res.status(500).send({ success: false });
      }
    }
  );

  app.post(
    "/media",
    upload.single("media"),
    async (req: Request, res: Response) => {
      try {
        if (!req.body.attachment_id) {
          return res
            .status(400)
            .send({ success: false, error: "attachment_id missing!" });
        }
        httpContext.set("attachment_id", req.body.attachment_id);
        oldAPILogger.notice("", { req: req });
        if (!req.file) {
          return res
            .status(400)
            .send({ success: false, error: "Media file is missing!" });
        }
        const fileHash = genHashFromFile(path.join(tempDir, req.file.filename));
        const prevMedia: Media | null = await ds.findOne({
          attachment_id: req.body.attachment_id,
        });
        if (prevMedia) {
          if (prevMedia.filename == fileHash) {
            return res.status(200).send({ success: true });
          } else {
            return res
              .status(403)
              .send({ success: false, error: "Cannot change uploaded file!" });
          }
        }
        // We move the file with the hash as name
        fs.renameSync(
          path.join(tempDir, req.file.filename),
          path.join(mediaDir, fileHash)
        );
        const media: Media = {
          filename: fileHash,
          attachment_id: req.body.attachment_id,
        };
        await ds.insert(media);
        if (fs.existsSync(path.join(tempDir, req.file.filename))) {
          // We delete the file from the uploads directory
          fs.unlinkSync(path.join(tempDir, req.file.filename));
        }

        return res.status(200).send({ success: true });
      } catch (error) {
        res.status(500).send({ success: false });
      }
    }
  );

  app.post("/ack", async (req: Request, res: Response) => {
    try {
      if (!req.body.blindedutxo) {
        return res
          .status(400)
          .send({ success: false, error: "blindedutxo missing!" });
      }
      httpContext.set("blindedutxo", req.body.blindedutxo);
      oldAPILogger.notice("", { req: req });
      const c: Consignment | null = await ds.findOne({
        blindedutxo: req.body.blindedutxo,
      });

      if (!c) {
        return res
          .status(404)
          .send({ success: false, error: "No consignment found!" });
      }
      if (!!c.responded) {
        return res
          .status(403)
          .send({ success: false, error: "Already responded!" });
      }
      await ds.update(
        { blindedutxo: req.body.blindedutxo },
        {
          $set: {
            ack: true,
            nack: false,
            responded: true,
          },
        },
        { multi: false }
      );

      return res.status(200).send({ success: true });
    } catch (error) {
      oldAPILogger.error(error);
      res.status(500).send({ success: false });
    }
  });

  app.post("/nack", async (req: Request, res: Response) => {
    try {
      if (!req.body.blindedutxo) {
        return res
          .status(400)
          .send({ success: false, error: "blindedutxo missing!" });
      }
      httpContext.set("blindedutxo", req.body.blindedutxo);
      oldAPILogger.notice("", { req: req });
      let c: Consignment | null = await ds.findOne({
        blindedutxo: req.body.blindedutxo,
      });
      if (!c) {
        return res.status(404).send({ success: false });
      }
      if (!!c.responded) {
        return res
          .status(403)
          .send({ success: false, error: "Already responded!" });
      }
      await ds.update(
        { blindedutxo: req.body.blindedutxo },
        {
          $set: {
            nack: true,
            ack: false,
            responded: true,
          },
        },
        { multi: false }
      );
      c = await ds.findOne({ blindedutxo: req.body.blindedutxo });

      return res.status(200).send({ success: true });
    } catch (error) {
      res.status(500).send({ success: false });
    }
  });

  app.get(
    "/ack/:blindedutxo",
    middleware,
    async (req: Request, res: Response) => {
      try {
        if (!req.params.blindedutxo) {
          return res
            .status(400)
            .send({ success: false, error: "blindedutxo missing!" });
        }
        const c: Consignment | null = await ds.findOne({
          blindedutxo: req.params.blindedutxo,
        });

        if (!c) {
          return res
            .status(404)
            .send({ success: false, error: "No consignment found!" });
        }
        const ack = !!c.ack;
        const nack = !!c.nack;

        return res.status(200).send({
          success: true,
          ack,
          nack,
        });
      } catch (error) {
        oldAPILogger.error(error);
        res.status(500).send({ success: false });
      }
    }
  );

  app.get("/getinfo", middleware, async (_req: Request, res: Response) => {
    return res.status(200).send({
      version: APP_VERSION,
      uptime: Math.trunc(process.uptime()),
    });
  });
};
