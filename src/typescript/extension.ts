/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { DebugProtocol } from 'vscode-debugprotocol';
import { MeadowProjectManager } from "./meadow-project-manager";
import { MeadowConfigurationProvider } from "./meadow-configuration";
import { OutputChannel } from 'vscode';
import { MeadowBuildTaskProvider } from './meadow-build-task';

const localize = nls.config({ locale: process.env.VSCODE_NLS_CONFIG })();

const configuration = vscode.workspace.getConfiguration('meadow');

let omnisharp: any = null;
let output: OutputChannel = null;

var currentDebugSession: vscode.DebugSession;

export function activate(context: vscode.ExtensionContext) {

	output = vscode.window.createOutputChannel("Meadow");

	this.MeadowProjectManager = new MeadowProjectManager(context);

	this.meadowBuildTaskProvider = vscode.tasks.registerTaskProvider(MeadowBuildTaskProvider.MeadowBuildScriptType, new MeadowBuildTaskProvider(vscode.workspace.rootPath));
	
	omnisharp = vscode.extensions.getExtension("ms-dotnettools.csharp").exports;

	omnisharp.eventStream.subscribe((e: any) => console.log(JSON.stringify(e)));

	context.subscriptions.push(vscode.commands.registerCommand('extension.meadow.configureExceptions', () => configureExceptions()));
	context.subscriptions.push(vscode.commands.registerCommand('extension.meadow.startSession', config => startSession(config)));

	const provider = new MeadowConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('meadow', provider, vscode.DebugConfigurationProviderTriggerKind.Initial | vscode.DebugConfigurationProviderTriggerKind.Dynamic));

	context.subscriptions.push(vscode.debug.onDidStartDebugSession(async (s) => {
		let type = s.type;

		if (type === "vslsShare") {
			const debugSessionInfo = await s.customRequest("debugSessionInfo");
			type = debugSessionInfo.configurationProperties.type;
		}

		if (type === "meadow") {
			currentDebugSession = s;
		}
	}));
	context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((s) => {
		if (s === currentDebugSession) {
			currentDebugSession = null;
			// this.reloadStatus.hide();
			// this.debugMetrics.hide();
			const debugSessionEnd = new Date();
			// this.disableAllServiceExtensions();
		}
	}));

	//output.appendLine("Initialization succeeded");
	output.show();
}

export function deactivate() {
}

//----- configureExceptions ---------------------------------------------------------------------------------------------------

// we store the exception configuration in the workspace or user settings as
type ExceptionConfigurations = { [exception: string]: DebugProtocol.ExceptionBreakMode; };

// if the user has not configured anything, we populate the exception configurationwith these defaults
const DEFAULT_EXCEPTIONS: ExceptionConfigurations = {
	"System.Exception": "never",
	"System.SystemException": "never",
	"System.ArithmeticException": "never",
	"System.ArrayTypeMismatchException": "never",
	"System.DivideByZeroException": "never",
	"System.IndexOutOfRangeException": "never",
	"System.InvalidCastException": "never",
	"System.NullReferenceException": "never",
	"System.OutOfMemoryException": "never",
	"System.OverflowException": "never",
	"System.StackOverflowException": "never",
	"System.TypeInitializationException": "never"
};

class BreakOptionItem implements vscode.QuickPickItem {
	label: string;
	description: string;
	breakMode: DebugProtocol.ExceptionBreakMode
}

// the possible exception options converted into QuickPickItem
const OPTIONS = ['never', 'always', 'unhandled'].map<BreakOptionItem>((bm: DebugProtocol.ExceptionBreakMode) => {
	return {
		label: translate(bm),
		description: '',
		breakMode: bm
	}
});

class ExceptionItem implements vscode.QuickPickItem {
	label: string;
	description: string;
	model: DebugProtocol.ExceptionOptions
}

function translate(mode: DebugProtocol.ExceptionBreakMode): string {
	switch (mode) {
		case 'never':
			return localize('breakmode.never', "Never break");
		case 'always':
			return localize('breakmode.always', "Always break");
		case 'unhandled':
			return localize('breakmode.unhandled', "Break when unhandled");
		default:
			return mode;
	}
}

function getModel(): ExceptionConfigurations {

	let model = DEFAULT_EXCEPTIONS;
	if (configuration) {
		const exceptionOptions = configuration.get('exceptionOptions');
		if (exceptionOptions) {
			model = <ExceptionConfigurations>exceptionOptions;
		}
	}
	return model;
}

function configureExceptions(): void {

	const options: vscode.QuickPickOptions = {
		placeHolder: localize('select.exception', "First Select Exception"),
		matchOnDescription: true,
		matchOnDetail: true
	};

	const exceptionItems: vscode.QuickPickItem[] = [];
	const model = getModel();
	for (var exception in model) {
		exceptionItems.push({
			label: exception,
			description: model[exception] !== 'never' ? `⚡ ${translate(model[exception])}` : ''
		});
	}

	vscode.window.showQuickPick(exceptionItems, options).then(exceptionItem => {

		if (exceptionItem) {

			const options: vscode.QuickPickOptions = {
				placeHolder: localize('select.break.option', "Then Select Break Option"),
				matchOnDescription: true,
				matchOnDetail: true
			};

			vscode.window.showQuickPick(OPTIONS, options).then(item => {
				if (item) {
					model[exceptionItem.label] = item.breakMode;
					if (configuration) {
						configuration.update('exceptionOptions', model);
					}
					setExceptionBreakpoints(model);
				}
			});
		}
	});
}

function setExceptionBreakpoints(model: ExceptionConfigurations): Thenable<DebugProtocol.SetExceptionBreakpointsResponse> {

	const args: DebugProtocol.SetExceptionBreakpointsArguments = {
		filters: [],
		exceptionOptions: convertToExceptionOptions(model)
	}

	return vscode.commands.executeCommand<DebugProtocol.SetExceptionBreakpointsResponse>('workbench.customDebugRequest', 'setExceptionBreakpoints', args);
}

function convertToExceptionOptions(model: ExceptionConfigurations): DebugProtocol.ExceptionOptions[] {

	const exceptionItems: DebugProtocol.ExceptionOptions[] = [];
	for (var exception in model) {
		exceptionItems.push({
			path: [{ names: [exception] }],
			breakMode: model[exception]
		});
	}
	return exceptionItems;
}

//----- configureExceptions ---------------------------------------------------------------------------------------------------

/**
 * The result type of the startSession command.
 */
class StartSessionResult {
	status: 'ok' | 'initialConfiguration' | 'saveConfiguration';
	content?: string;	// launch.json content for 'save'
};

function startSession(config: any): StartSessionResult {

	if (config && !config.__exceptionOptions) {
		config.__exceptionOptions = convertToExceptionOptions(getModel());
	}

	vscode.commands.executeCommand('vscode.startDebug', config);

	return {
		status: 'ok'
	};
}