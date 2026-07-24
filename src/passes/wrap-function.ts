import { Pass, PassContext } from "./types";
import { funcExpr, paren, callExpr, varargParam, returnStmt } from "../ast/builders";

export const wrapInFunction: Pass<Record<string, never>> = (chunk, ctx: PassContext) => {
    const fn = funcExpr([varargParam()], chunk.body, true);
    const call = callExpr(paren(fn), [varargParam()]);

    chunk.body = [returnStmt([call])];

    return chunk;
}