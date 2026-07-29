function partialMarkerLength(value, marker) {
	const maximum = Math.min(value.length, marker.length - 1);
	for (let length = maximum; length > 0; length -= 1) {
		if (value.endsWith(marker.slice(0, length))) {
			return length;
		}
	}
	return 0;
}

function consumeExitMarkers(state, data, marker) {
	const combined = `${state.markerRemainder || ""}${String(data || "")}`;
	let visibleData = "";
	let cursor = 0;
	let markerCount = 0;
	let markerIndex = combined.indexOf(marker, cursor);
	while (markerIndex >= 0) {
		visibleData += combined.slice(cursor, markerIndex);
		cursor = markerIndex + marker.length;
		markerCount += 1;
		markerIndex = combined.indexOf(marker, cursor);
	}

	const tail = combined.slice(cursor);
	const remainderLength = partialMarkerLength(tail, marker);
	visibleData += tail.slice(0, tail.length - remainderLength);
	state.markerRemainder = tail.slice(tail.length - remainderLength);
	return { visibleData, markerCount };
}

function flushMarkerRemainder(state) {
	const remainder = state.markerRemainder || "";
	state.markerRemainder = "";
	return remainder;
}

module.exports = {
	consumeExitMarkers,
	flushMarkerRemainder,
};
