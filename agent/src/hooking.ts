import { FilterType } from './lib/types';
import { IFilter, IFunctionPointer } from './lib/interfaces';
import { objcObjectDebugDesc, wildcardMatch } from './lib/helpers';
import { xpcConnectionGetName,
		xpcConnectionCallEventHandler,
		xpcGetType,
		} from './lib/systemFunctions';
import { formatConnectionDescription,
		formatMessageDescription } from './lib/formatters';
import { outgoingXPCMessagesFunctionPointer } from './consts';
import { parseBPListKeysRecursively } from './lib/parsers';

/**
 * TODO:
 *  - Use a class for the agent, makes more sense to store `shouldParse` and so on there.
 *  - Add option to fetch the process' name in the connection description.
 * 	- Handle peer connections more explicitly; they have no name.
 * 	- Add option to filter services by pid.
 */


export function installHooks(filter: IFilter, shouldParse: boolean) {
	const pointers: IFunctionPointer[] = [];
	
	if (filter.type & FilterType.Outgoing) {
		pointers.push(...outgoingXPCMessagesFunctionPointer);
	}

	if (filter.type & FilterType.Incoming) {
		pointers.push(xpcConnectionCallEventHandler);
	}
	
	for (let pointer of pointers) {
		Interceptor.attach(pointer.ptr, 
			{ 
				onEnter: function(this: InvocationContext, args: InvocationArguments) {
					_onEnterHandler(pointer.name, args, filter.connectionNamePattern, shouldParse);
				} 
			});
	}

	send({
		'type': 'agent:hooks_installed'
	});
}

const _onEnterHandler = function(symbol: string,
								args: InvocationArguments,
								connectionNamePattern: string,
								shouldParse: boolean): void {
	const p_connection = new NativePointer(args[0]);
	const connectionName = (<NativePointer>xpcConnectionGetName.call(p_connection)).readCString();
	if (connectionNamePattern != '*' && connectionName && !wildcardMatch(connectionName, connectionNamePattern)) {
		return;
	}

	const ts = Date.now();  // Resolution isn't high enough, will have to use a dict of stacks in Python
	/*
	 * Send a message to the application as soon as a new function is traced,
	 * then collect/parse data (connection & dict objects, etc.) and send them to the app.
	 * The app then will output full invocation data in sync, using the timestamp.
	*/
	send({
		type: 'agent:trace:symbol',
		message: {timestamp: ts, symbol: symbol}
	});

	let connectionDesc = objcObjectDebugDesc((p_connection));
	// connectionDesc = formatConnectionDescription(connectionDesc);  // This is buggy, fix it later

	const p_message = new NativePointer(args[1]);
	let messageDesc = objcObjectDebugDesc(p_message);


	if (shouldParse) {
		const messageType = objcObjectDebugDesc(<NativePointer>xpcGetType.call(p_message));
		if (messageType == 'OS_xpc_dictionary') {
            const parsingResult = parseBPListKeysRecursively(p_connection, p_message);
            if (parsingResult.length > 0) {
                messageDesc = formatMessageDescription(messageDesc, parsingResult);
            }
		} // Parse `OS_xpc_data` as well?
	}

	send({
		type: 'agent:trace:data',
		message: 
		{
			timestamp: ts, 
			data: { conn: connectionDesc, message: messageDesc } 
		}
	});
}
